import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer, ProtocolError, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BridgeConfig } from "./config.js";
import type { CodexJobRegistry } from "./tools.js";
import { isMissingConversationScopeError, type ScopeResolver, type ToolCallMetadata } from "./scopeResolver.js";
import { JOB_TERMINAL_EVENT, type EventJob, type EventSubscription } from "./mcpEventStore.js";
import { EventDestinationVault, sendPublicWebhook, signedHeaders, validateCallbackUrl, validateSigningSecret, type WebhookSender } from "./mcpWebhook.js";
import { FOLLOWUP_ID_PATTERN } from "./taskFollowups.js";
import { mcpOAuthPrincipal } from "./mcpOAuth.js";
import {combineShutdown,shutdownResult,type ShutdownResult} from "./shutdown.js";
import {snapshotNonforcingData} from "./nonforcingData.js";
import {RuntimeOperationFence} from "./runtimeOperationFence.js";

const argsSchema = z.strictObject({ jobId: z.string().uuid() });
const deliverySchema = z.strictObject({ mode: z.literal("webhook"), url: z.string().max(4_096), secret: z.string().max(100) });
const subscribeSchema = z.strictObject({
  name: z.literal(JOB_TERMINAL_EVENT), arguments: argsSchema, delivery: deliverySchema,
  _meta: z.record(z.string(), z.unknown()).optional(),
  cursor: z.null().optional(), ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional()
});
const unsubscribeSchema = z.strictObject({
  name: z.literal(JOB_TERMINAL_EVENT), arguments: argsSchema,
  _meta: z.record(z.string(), z.unknown()).optional(),
  delivery: deliverySchema.omit({ secret: true })
});
const SUBSCRIPTION_TTL_MS = 60 * 60 * 1_000;
const MAX_TTL_MS = 24 * SUBSCRIPTION_TTL_MS;
const MAX_ATTEMPTS = 8;
const VERIFICATION_CACHE_MS = 5 * 60 * 1_000;
const ROTATION_MS = 5 * 60 * 1_000;

export function mcpBearerPrincipal(token: string): string {
  return "bridge-bearer-" + createHash("sha256").update("mcp-events/principal/v1\0" + token).digest("hex");
}

const eventAuthSchema=z.object({scopes:z.array(z.string()),expiresAt:z.number().finite().nonnegative().optional(),
  extra:z.object({bridgeMcpPrincipal:z.string().min(1)}).passthrough()}).passthrough();
function eventAuthPrincipal(auth:unknown):string|undefined {
  const parsed=eventAuthSchema.safeParse(auth);
  if(!parsed.success || !parsed.data.scopes.includes('bridge') ||
    parsed.data.expiresAt!==undefined && parsed.data.expiresAt*1000<=Date.now())return undefined;
  return parsed.data.extra.bridgeMcpPrincipal;
}
export function authenticatedMcpPrincipal(context: Pick<ServerContext, "http">): string | undefined {
  const captured=snapshotNonforcingData(context.http?.authInfo,()=>false);
  return captured.ok?eventAuthPrincipal(captured.value):undefined;
}

export const JOB_TERMINAL_EVENT_DEFINITION = {
  name: JOB_TERMINAL_EVENT,
  description: "An exact owned Codex Job has a committed terminal result or failure. Retrieve its original state with codex_status. Notification is not approval for a new task; only a previously approved followup step may be admitted after result review.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(argsSchema),
  payloadSchema: {
    type: "object", additionalProperties: false,
    properties: {
      jobId: { type: "string", format: "uuid" },
      activityId: { type: ["string", "null"] }, agentId: { type: ["string", "null"] },
      state: { enum: ["completed", "failed", "interrupted", "cancelled"] },
      terminalVersion: { type: "integer", minimum: 1 },
      availableFollowups: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
        properties: { followupId: { type: "string", pattern: FOLLOWUP_ID_PATTERN.source } }, required: ["followupId"] } },
      result: { type: "object", additionalProperties: false,
        properties: { tool: { const: "codex_status" }, query: { type: "object", additionalProperties: false,
          properties: { kind: { const: "job" }, id: { type: "string", format: "uuid" } }, required: ["kind", "id"] } }, required: ["tool", "query"] }
    }, required: ["jobId", "activityId", "agentId", "state", "terminalVersion", "result"]
  }
};

/** One bounded outbound worker in the existing state owner. HTTP request-scoped
 * SDK servers share it; it observes durable subscriptions rather than polling
 * Codex, predicting completion, or admitting any work. */
export class McpEventsController {
  private readonly vault?: EventDestinationVault;
  private readonly principal?: string;
  private readonly stop = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private readonly unsubscribe: () => void;
  private readonly verifying = new Map<string, number>();
  private nonforcingPinned=false;
  private nonforcingUnknown=false;
  private ordinaryClose=false;
  private readonly retainedResponses=new Map<string,unknown>();
  private readonly retainedErrors=new Map<string,unknown>();
  private readonly senderFence=new RuntimeOperationFence();
  private readonly requestFence=new RuntimeOperationFence();
  private readonly delegateFence=new RuntimeOperationFence();
  private readonly unsubscribeFence=new RuntimeOperationFence();

  pinNonforcingShutdown():true {
    if(this.nonforcingPinned)return true;
    this.nonforcingPinned=true;this.nonforcingUnknown ||= this.ordinaryClose;
    this.senderFence.pinNonforcingShutdown();
    this.requestFence.pinNonforcingShutdown();
    this.delegateFence.pinNonforcingShutdown();
    this.stop.abort();
    try{this.unsubscribeFence.runSynchronous(()=>{
      this.unsubscribeFence.pinNonforcingShutdown();
      const raw=Reflect.apply(this.unsubscribe,this,[]);
      if(raw!==undefined){this.retainedErrors.set('unsubscribe-result',raw);this.nonforcingUnknown=true;}
      return raw;
    });}catch(error){this.nonforcingUnknown=true;this.retainedErrors.set('unsubscribe',error);}
    finally{this.unsubscribeFence.pinNonforcingShutdown();}
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    return true;
  }
  observeNonforcingExit():ShutdownResult {
    if(!this.nonforcingPinned || this.nonforcingUnknown)return shutdownResult('uncertain');
    const active=this.verifying.size+(this.running?1:0);
    return combineShutdown([active ? shutdownResult('timeout',active) : shutdownResult('exited'),this.senderFence.observeNonforcingExit(),this.requestFence.observeNonforcingExit(),this.delegateFence.observeNonforcingExit(),this.unsubscribeFence.observeNonforcingExit()]);
  }
  async closeNonforcing():Promise<ShutdownResult>{
    this.pinNonforcingShutdown();
    try{await this.running;}catch{this.nonforcingUnknown=true;}
    return this.observeNonforcingExit();
  }

  constructor(private readonly config: BridgeConfig, private readonly jobs: CodexJobRegistry,
    private readonly scopes: ScopeResolver, private readonly sender: WebhookSender = sendPublicWebhook) {
    if (config.token && !config.noAuth) {
      this.principal = config.oauth ? mcpOAuthPrincipal(config.oauth) : mcpBearerPrincipal(config.token);
      this.vault = new EventDestinationVault(config.token);
    }
    this.unsubscribe = jobs.subscribeChanges(reason => { if (reason === "terminal") this.wake(); });
    this.wake();
  }

  install(server: McpServer): void {
    // SDK v2's core types do not yet include the draft Events extension.
    server.server.registerCapabilities({ events: {} } as Parameters<typeof server.server.registerCapabilities>[0]);
    server.server.setRequestHandler("events/list", { params: z.strictObject({ cursor: z.null().optional(), _meta: z.record(z.string(), z.unknown()).optional() }) }, (_params, context) => this.requestFence.run(()=>{
      this.authorize(context);
      this.assertAdmission();
      return { events: [JOB_TERMINAL_EVENT_DEFINITION], ttlMs: 0, cacheScope: "private" };
    }));
    server.server.setRequestHandler("events/subscribe", { params: subscribeSchema }, (params, context) => this.subscribe(params, context));
    server.server.setRequestHandler("events/unsubscribe", { params: unsubscribeSchema }, (params, context) => this.requestFence.run(()=>{
      params=this.ownedData(params,'unsubscribe-params');
      const principal = this.authorize(context);
      this.assertAdmission();
      const scopeId=this.requireOwnedScope(context,'Event unsubscribe');
      const id = this.identity(principal, scopeId, params.arguments.jobId, params.delivery.url);
      if (this.verifying.has(id)) this.verifying.set(id, this.verifying.get(id)! + 1);
      const state=this.jobs.admissionStateStore;this.assertAdmission();
      const ledger = state.mcpEvents;
      this.assertAdmission();
      this.ownedCall(this.jobs,'activityTransaction',[() => {
        const record=this.ownedData(this.ownedCall(ledger,'get',[params.arguments.jobId,id]),'unsubscribe-record');
        this.assertAdmission();
        if (!record) return;
        if (record.scopeId !== scopeId || record.principal !== principal) throw this.denied();
        const saved=this.ownedCall(ledger,'save',[{...record,revision:record.revision+1,disabled:'unsubscribed'},record.revision]);
        this.assertAdmission();
        if(!saved) {
          throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        }
      }]);
      this.assertAdmission();
      return {};
    }));
  }

  private async subscribe(params: z.infer<typeof subscribeSchema>, context: ServerContext) {
    const id=randomUUID();
    try{return await this.requestFence.run(()=>this.subscribeOwned(params,context));}
    catch(error){this.retainedErrors.set('subscription:'+id,error);throw error;}
  }

  private assertAdmission():void {
    if(this.nonforcingPinned)throw new Error('MCP_EVENTS_NONFORCING_PINNED');
  }

  private ownedMethod<T extends object,K extends keyof T>(owner:T,key:K):T[K] {
    this.assertAdmission();const method=owner[key];
    if(this.nonforcingPinned){this.nonforcingUnknown=true;this.retainedErrors.set('method:'+String(key),method);}
    this.assertAdmission();return method;
  }
  private ownedCall<T extends object,K extends keyof T>(owner:T,key:K,args:unknown[]):ReturnType<Extract<T[K],(...args:any[])=>any>> {
    this.assertAdmission();let value:unknown;
    try {
      const result=this.delegateFence.runSynchronous(()=>{
        const method=this.ownedMethod(owner,key);value=Reflect.apply(method as (...args:any[])=>any,owner,args);
        return value;
      });
      if(this.nonforcingPinned || key==='save' && typeof result!=='boolean' ||
        (key==='maintain'||key==='enqueue') && result!==undefined) {
        this.nonforcingUnknown=true;this.retainedErrors.set('call-result:'+String(key),value);
        throw new Error('MCP_EVENTS_SYNC_RESULT_UNCONFIRMED');
      }
      this.assertAdmission();return result as ReturnType<Extract<T[K],(...args:any[])=>any>>;
    }catch(error){
      this.nonforcingUnknown=true;this.retainedErrors.set('call-result:'+String(key),value);
      this.retainedErrors.set('call-error:'+String(key),error);throw error;
    }
  }

  private ownedData<T>(value:T,label:string):T {
    const captured=snapshotNonforcingData(value,()=>this.nonforcingPinned);
    if(!captured.ok){this.nonforcingUnknown=true;this.retainedErrors.set(label,value);throw new Error('MCP_EVENTS_DATA_UNCONFIRMED');}
    this.assertAdmission();return captured.value;
  }

  private ownedFields<T>(value:object,keys:readonly string[],label:string):T {
    const fields:Record<string,unknown>={};
    for(const key of keys){
      this.assertAdmission();const field=Object.getOwnPropertyDescriptor(value,key);
      if(this.nonforcingPinned || field&&!Object.hasOwn(field,'value')) {
        this.nonforcingUnknown=true;this.retainedErrors.set(label,value);throw new Error('MCP_EVENTS_DATA_UNCONFIRMED');
      }
      fields[key]=field?.value;
    }
    const captured=snapshotNonforcingData(fields,()=>this.nonforcingPinned);
    if(!captured.ok){this.nonforcingUnknown=true;this.retainedErrors.set(label,value);throw new Error('MCP_EVENTS_DATA_UNCONFIRMED');}
    this.assertAdmission();return captured.value as T;
  }

  private requestSignal(context:ServerContext):AbortSignal {
    const request=context.mcpReq;
    if(this.nonforcingPinned){this.nonforcingUnknown=true;this.retainedErrors.set('signal-request',request);}
    this.assertAdmission();
    const signal=request.signal;
    if(this.nonforcingPinned){this.nonforcingUnknown=true;this.retainedErrors.set('request-signal',signal);}
    this.assertAdmission();return signal;
  }

  private requireOwnedScope(context:ServerContext,label:string):string {
    const request=context.mcpReq;this.assertAdmission();
    const metadata=request._meta;this.assertAdmission();
    let scope;
    try {
      scope=this.ownedCall(this.scopes,'require',[metadata as ToolCallMetadata,undefined,label]);
    } catch(error) {
      // A pinned delegate retains its raw uncertainty and cannot be normalized
      // into an ordinary metadata rejection.
      this.assertAdmission();
      if(isMissingConversationScopeError(error)) {
        throw new ProtocolError(-32001,"Events require original conversation metadata.",{reason:"missing_conversation_scope"});
      }
      throw new ProtocolError(-32001,"Events require valid original conversation metadata.",{reason:"invalid_conversation_scope"});
    }
    this.assertAdmission();
    // Preserve the existing pre-pin resolution contract. A synchronous scope
    // accessor may pin while the request is owned; no continuation crosses it.
    const scopeId=scope.scopeId;
    if(this.nonforcingPinned){this.nonforcingUnknown=true;this.retainedErrors.set('conversation-scope',scope);}
    this.assertAdmission();return scopeId;
  }

  private async subscribeOwned(params: z.infer<typeof subscribeSchema>, context: ServerContext) {
    this.assertAdmission();
    params=this.ownedData(params,'subscribe-params');
    const principal = this.authorize(context);
    this.assertAdmission();
    const scopeId=this.requireOwnedScope(context,'Event subscription');
    this.requireJob(params.arguments.jobId, scopeId, principal);
    this.assertAdmission();
    const id = this.identity(principal, scopeId, params.arguments.jobId, params.delivery.url);
    const state=this.jobs.admissionStateStore;this.assertAdmission();
    const ledger=state.mcpEvents;
    this.assertAdmission();
    this.ownedCall(ledger,'maintain',[]);
    this.assertAdmission();
    const old = this.ownedData(this.ownedCall(ledger,'get',[params.arguments.jobId,id]),'subscribe-old-record');
    this.assertAdmission();
    if (this.verifying.has(id) || this.verifying.size >= 8) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "verification_busy" });
    this.verifying.set(id, 0);
    try {
      let destination;
      try {
        validateCallbackUrl(params.delivery.url);
        validateSigningSecret(params.delivery.secret);
        destination = old && old.principal === principal ? this.vault!.open(id, old.destination) : undefined;
      } catch { throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "invalid_destination_or_secret" }); }
      const now = Date.now();
      if (!old || old.disabled || old.verifiedAt + VERIFICATION_CACHE_MS <= now || destination?.secret !== params.delivery.secret) {
        const challenge = randomUUID();
        const body = JSON.stringify({ type: "verification", challenge });
        const verificationId = "msg_verification_" + randomUUID();
        try {
          const signal=this.requestSignal(context);
          const response = await this.senderFence.run(()=>this.sender(params.delivery.url, body,
            signedHeaders(verificationId, id, body, [params.delivery.secret]),
            AbortSignal.any([this.stop.signal, signal, AbortSignal.timeout(10_000)])));
          this.retainedResponses.set(id,response);
          if(this.stop.signal.aborted)throw new Error('RUNTIME_NONFORCING_PINNED');
          const captured=snapshotNonforcingData(response,()=>this.nonforcingPinned);
          if(!captured.ok){this.nonforcingUnknown=true;throw new Error('MCP_EVENT_RESPONSE_UNCONFIRMED');}
          const observed=captured.value;
          const returned = JSON.parse(observed.body).challenge;
          const expected = Buffer.from(challenge);
          const actual = typeof returned === "string" ? Buffer.from(returned) : Buffer.alloc(0);
          if (observed.status < 200 || observed.status >= 300 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("challenge_failed");
        } catch (error) {
          this.retainedErrors.set(id,error);
          if(this.stop.signal.aborted)throw new ProtocolError(-32015,'CallbackEndpointError',{reason:'timeout'});
          const message=error && typeof error==='object' ? Object.getOwnPropertyDescriptor(error,'message') : undefined;
          if(this.stop.signal.aborted)throw new ProtocolError(-32015,'CallbackEndpointError',{reason:'timeout'});
          const reason=message && Object.hasOwn(message,'value') && message.value==='timeout'?'timeout':'challenge_failed';
          throw new ProtocolError(-32015, "CallbackEndpointError", { reason });
        }
      }
      if(this.stop.signal.aborted)throw new ProtocolError(-32015,'CallbackEndpointError',{reason:'timeout'});
      this.retainedResponses.delete(id);
      const verifiedAt = Date.now();
      const auth=this.authorizedAuth(context); // Validate expiry again after network verification.
      const expiresAt = Math.min(verifiedAt + Math.min(params.ttlMs ?? SUBSCRIPTION_TTL_MS, MAX_TTL_MS),
        auth.expiresAt!==undefined?auth.expiresAt*1000:Infinity);
      this.ownedCall(this.jobs,'activityTransaction',[() => {
        const current=this.ownedData(this.ownedCall(ledger,'get',[params.arguments.jobId,id]),'subscribe-current-record');
        this.assertAdmission();
        if (this.verifying.get(id) !== 0) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        if ((current?.revision || 0) !== (old?.revision || 0)) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        const job = this.requireJob(params.arguments.jobId, scopeId, principal);
        this.assertAdmission();
        if (this.requestSignal(context).aborted || this.stop.signal.aborted) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "timeout" });
        const rotating = destination && destination.secret !== params.delivery.secret;
        // Delivery can advance without changing the grant revision while the
        // challenge awaits. Preserve its event, ACK, attempts and retry state.
        const saved = this.ownedCall(ledger,'save',[{
          ...current,
          id, jobId: job.jobId, scopeId, principal, verifiedAt, expiresAt, revision: (current?.revision || 0) + 1,
          disabled: undefined,
          destination: this.vault!.seal(id, { url: params.delivery.url, secret: params.delivery.secret,
            ...(rotating ? { previousSecret: destination!.secret, rotateUntil: verifiedAt + ROTATION_MS }
              : destination?.rotateUntil && destination.rotateUntil > verifiedAt ? { previousSecret: destination.previousSecret, rotateUntil: destination.rotateUntil } : {}) }),
          delivery: current?.delivery || "waiting", attempts: current?.attempts || 0, nextAttemptAt: current?.nextAttemptAt || 0
        }, current?.revision ?? 0]);
        this.assertAdmission();
        if (!saved) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        this.ownedCall(ledger,'enqueue',[job]);this.assertAdmission();
      }]);
      this.assertAdmission();
      this.wake();
      return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
    } finally { this.verifying.delete(id); }
  }

  private authorizedAuth(context:ServerContext) {
    this.assertAdmission();
    const http=context.http;
    if(this.nonforcingPinned){this.nonforcingUnknown=true;this.retainedErrors.set('auth-http',http);}
    this.assertAdmission();
    const auth=http?.authInfo;
    if(this.nonforcingPinned){this.nonforcingUnknown=true;this.retainedErrors.set('auth-info',auth);}
    this.assertAdmission();
    const captured=snapshotNonforcingData(auth,()=>this.nonforcingPinned);
    // Capture unsupported raw data before a descriptor trap's pin can throw.
    if(!captured.ok){this.nonforcingUnknown=true;this.retainedErrors.set('auth-info',auth);throw this.denied();}
    this.assertAdmission();
    if(!this.principal || eventAuthPrincipal(captured.value)!==this.principal)throw this.denied();
    return {principal:this.principal,expiresAt:eventAuthSchema.parse(captured.value).expiresAt};
  }
  private authorize(context: ServerContext): string {return this.authorizedAuth(context).principal;}

  private denied() { return new ProtocolError(-32001, "Events require an authenticated connection and the original conversation's owned Job."); }

  private requireJob(jobId: string, scopeId: string, principal: string): EventJob {
    const original=this.ownedCall(this.jobs,'get',[jobId]);this.assertAdmission();
    if(!original)throw this.denied();
    const job=this.ownedFields<EventJob>(original,['jobId','scopeId','activityId','agentId','projectId','mcpPrincipal','status','version','updatedAt','approvedFollowups'],'event-job');
    if(job.jobId!==jobId || job.scopeId!==scopeId || job.mcpPrincipal!==principal || !job.activityId || !job.agentId)throw this.denied();
    const activity=this.ownedCall(this.jobs,'getActivity',[job.activityId]);this.assertAdmission();
    if(!activity || this.ownedFields<{scopeId:string}>(activity,['scopeId'],'event-activity').scopeId!==scopeId)throw this.denied();
    const agent=this.ownedCall(this.jobs,'getAgent',[job.agentId]);this.assertAdmission();
    if(!agent || this.ownedFields<{scopeId:string}>(agent,['scopeId'],'event-agent').scopeId!==scopeId)throw this.denied();
    const state=this.jobs.admissionStateStore;this.assertAdmission();
    if(job.projectId){const allowed=this.ownedCall(state,'isEventProjectAvailable',[job.projectId]);this.assertAdmission();if(!allowed)throw this.denied();}
    const rawCompletion=this.ownedCall(state,'getJobCompletionDelivery',[jobId,scopeId]);this.assertAdmission();
    const completion=rawCompletion?this.ownedFields<{terminalVersion:number;createdAt:number}>(rawCompletion,['terminalVersion','createdAt'],'event-completion'):undefined;
    return {...job,terminalVersion:completion?.terminalVersion,updatedAt:completion?.createdAt||job.updatedAt};
  }

  private identity(principal: string, scopeId: string, jobId: string, url: string): string {
    return "sub_" + createHash("sha256").update(JSON.stringify([principal, scopeId, JOB_TERMINAL_EVENT, { jobId }, url])).digest("hex");
  }

  wake(): void {
    if(this.stop.signal.aborted || this.running)return;
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{
      this.timer=undefined;
      // The owner stays registered through delivery AND its next-deadline read.
      this.running=Promise.resolve().then(()=>this.deliver()).then(()=>{
        if(this.stop.signal.aborted)return;
        const now=Date.now(),state=this.jobs.admissionStateStore;this.assertAdmission();
        const ledger=state.mcpEvents;this.assertAdmission();
        const deadlines=this.ownedData(this.ownedCall(ledger,'list',[]),'event-timer-records').flatMap(record=>[
          Math.max(record.expiresAt,record.recoverUntil||0),
          ...(!record.disabled&&record.expiresAt>now&&record.event&&record.delivery==='pending'?[record.nextAttemptAt]:[])
        ]);
        this.assertAdmission();
        if(deadlines.length){this.timer=setTimeout(()=>{this.timer=undefined;this.wake();},Math.max(100,Math.min(...deadlines)-now));this.timer.unref();}
      }).catch(error=>{
        this.nonforcingUnknown=true;this.retainedErrors.set('delivery',error);
        // Ordinary delivery failures retain the existing bounded retry. Pin
        // permanently prevents installing another timer from this continuation.
        if(!this.stop.signal.aborted){this.timer=setTimeout(()=>{this.timer=undefined;this.wake();},10_000);this.timer.unref();}
      })
        .finally(()=>{this.running=undefined;});
    },0);this.timer.unref();
  }

  private async deliver(): Promise<void> {
    if(this.stop.signal.aborted)return;
    const state=this.jobs.admissionStateStore;this.assertAdmission();
    const ledger = state.mcpEvents;this.assertAdmission();
    this.ownedCall(ledger,'maintain',[]);
    if(this.stop.signal.aborted)return;
    const records=this.ownedData(this.ownedCall(ledger,'list',[]),'event-delivery-records');
    if(this.stop.signal.aborted)return;
    for (const { jobId, id } of records) {
      if (this.stop.signal.aborted) break;
      // Another subscription's network await may have allowed this grant to
      // expire, renew or unsubscribe. The list supplies identities only.
      const record = this.ownedData(this.ownedCall(ledger,'get',[jobId,id]),'event-delivery-record');
      if(this.stop.signal.aborted)break;
      if (!record || record.disabled || record.expiresAt <= Date.now() || record.delivery !== "pending" || record.nextAttemptAt > Date.now()) continue;
      if (!record.event) continue;
      if (record.attempts >= MAX_ATTEMPTS) { this.ownedCall(ledger,'save',[{...record,delivery:'failed'},record.revision]); continue; }
      try { this.requireJob(record.jobId, record.scopeId, record.principal); if (record.principal !== this.principal) throw this.denied(); }
      catch (error) {
        if(this.stop.signal.aborted){this.retainedErrors.set(record.id,error);break;}
        // An unavailable state read is not evidence of revoked access.
        if (!(error instanceof ProtocolError)) throw error;
        this.ownedCall(ledger,'save',[{...record,revision:record.revision+1,disabled:'revoked'},record.revision]); continue;
      }
      if(this.stop.signal.aborted)break;
      let response;
      // Persist before opening keys or sending, including failed signing attempts.
      record.attempts += 1;
      if (!this.ownedCall(ledger,'save',[record,record.revision])) continue;
      try {
        const destination = this.vault!.open(record.id, record.destination);
        const body = JSON.stringify(record.event);
        const secrets = [destination.secret];
        if (destination.previousSecret && (destination.rotateUntil || 0) > Date.now()) secrets.push(destination.previousSecret);
        const eventId=record.event.eventId;
        response = await this.senderFence.run(()=>this.sender(destination.url, body,
          signedHeaders(eventId, record.id, body, secrets),
          AbortSignal.any([this.stop.signal, AbortSignal.timeout(10_000)])));
      } catch (error) {
        this.retainedErrors.set(record.id,error);
        if(this.stop.signal.aborted){this.retainedResponses.set(record.id,error);break;}
        response = { status: 0 };
      }
      this.retainedResponses.set(record.id,response);
      if (this.stop.signal.aborted) break;
      const captured=snapshotNonforcingData(response,()=>this.nonforcingPinned);
      if(!captured.ok){this.nonforcingUnknown=true;break;}
      response=captured.value;
      if(this.stop.signal.aborted)break;
      this.retainedResponses.delete(record.id);
      const current = this.ownedData(this.ownedCall(ledger,'get',[record.jobId,record.id]),'event-delivery-current');
      if (!current || current.revision !== record.revision || current.disabled || current.expiresAt <= Date.now() ||
          current.delivery !== "pending" || current.event?.eventId !== record.event.eventId) continue;
      const status = response.status;
      const acknowledged = status >= 200 && status < 300;
      const transient = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
      const failed = !acknowledged && (!transient || current.attempts >= MAX_ATTEMPTS);
      this.ownedCall(ledger,'save',[{ ...current, lastStatus: status,
        delivery: acknowledged ? "acknowledged" : failed ? "failed" : "pending",
        ...(status === 410 ? { disabled: "gone" as const, revision: current.revision + 1 } : {}),
        ...(acknowledged ? { acknowledgedAt: Date.now() } : {}),
        nextAttemptAt: Date.now() + Math.min(60_000, 1_000 * 2 ** current.attempts)
      }, current.revision]);
    }
  }

  async close(): Promise<void> {
    if(this.nonforcingPinned){if(!(await this.closeNonforcing()).exited)throw new Error('NONFORCING_SHUTDOWN_UNCONFIRMED');return;}
    this.ordinaryClose=true;this.stop.abort();this.unsubscribe();if(this.timer)clearTimeout(this.timer);await this.running;
  }
}
