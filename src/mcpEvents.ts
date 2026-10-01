import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer, ProtocolError, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BridgeConfig } from "./config.js";
import type { CodexJobRegistry } from "./tools.js";
import type { ScopeResolver, ToolCallMetadata } from "./scopeResolver.js";
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

export function authenticatedMcpPrincipal(context: Pick<ServerContext, "http">): string | undefined {
  const auth = context.http?.authInfo;
  if (!auth?.scopes.includes("bridge") || (auth.expiresAt !== undefined && auth.expiresAt * 1_000 <= Date.now())) return undefined;
  return typeof auth.extra?.bridgeMcpPrincipal === "string" ? auth.extra.bridgeMcpPrincipal : undefined;
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

  pinNonforcingShutdown():true {
    if(this.nonforcingPinned)return true;
    this.nonforcingPinned=true;this.nonforcingUnknown ||= this.ordinaryClose;
    this.senderFence.pinNonforcingShutdown();
    this.stop.abort();
    try{this.unsubscribe();}catch(error){this.nonforcingUnknown=true;this.retainedErrors.set('unsubscribe',error);}
    if(this.timer)clearTimeout(this.timer);this.timer=undefined;
    return true;
  }
  observeNonforcingExit():ShutdownResult {
    if(!this.nonforcingPinned || this.nonforcingUnknown)return shutdownResult('uncertain');
    const active=this.verifying.size+(this.running?1:0);
    return combineShutdown([active ? shutdownResult('timeout',active) : shutdownResult('exited'),this.senderFence.observeNonforcingExit()]);
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
    server.server.setRequestHandler("events/list", { params: z.strictObject({ cursor: z.null().optional(), _meta: z.record(z.string(), z.unknown()).optional() }) }, (_params, context) => {
      this.authorize(context);
      return { events: [JOB_TERMINAL_EVENT_DEFINITION], ttlMs: 0, cacheScope: "private" };
    });
    server.server.setRequestHandler("events/subscribe", { params: subscribeSchema }, (params, context) => this.subscribe(params, context));
    server.server.setRequestHandler("events/unsubscribe", { params: unsubscribeSchema }, (params, context) => {
      const principal = this.authorize(context);
      const scopeId = this.scopes.require(context.mcpReq._meta as ToolCallMetadata, undefined, "Event unsubscribe").scopeId;
      const id = this.identity(principal, scopeId, params.arguments.jobId, params.delivery.url);
      if (this.verifying.has(id)) this.verifying.set(id, this.verifying.get(id)! + 1);
      const ledger = this.jobs.admissionStateStore.mcpEvents;
      this.jobs.activityTransaction(() => {
        const record = ledger.get(params.arguments.jobId, id);
        if (!record) return;
        if (record.scopeId !== scopeId || record.principal !== principal) throw this.denied();
        if (!ledger.save({ ...record, revision: record.revision + 1, disabled: "unsubscribed" }, record.revision)) {
          throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        }
      });
      return {};
    });
  }

  private async subscribe(params: z.infer<typeof subscribeSchema>, context: ServerContext) {
    const principal = this.authorize(context);
    const scopeId = this.scopes.require(context.mcpReq._meta as ToolCallMetadata, undefined, "Event subscription").scopeId;
    this.requireJob(params.arguments.jobId, scopeId, principal);
    const id = this.identity(principal, scopeId, params.arguments.jobId, params.delivery.url);
    const ledger = this.jobs.admissionStateStore.mcpEvents;
    ledger.maintain();
    const old = ledger.get(params.arguments.jobId, id);
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
          const response = await this.senderFence.run(()=>this.sender(params.delivery.url, body,
            signedHeaders(verificationId, id, body, [params.delivery.secret]),
            AbortSignal.any([this.stop.signal, context.mcpReq.signal, AbortSignal.timeout(10_000)])));
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
      this.authorize(context); // A token can expire while the callback challenge is running.
      const expiresAt = Math.min(verifiedAt + Math.min(params.ttlMs ?? SUBSCRIPTION_TTL_MS, MAX_TTL_MS),
        context.http?.authInfo?.expiresAt !== undefined ? context.http.authInfo.expiresAt * 1_000 : Infinity);
      this.jobs.activityTransaction(() => {
        const current = ledger.get(params.arguments.jobId, id);
        if (this.verifying.get(id) !== 0) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        if ((current?.revision || 0) !== (old?.revision || 0)) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        const job = this.requireJob(params.arguments.jobId, scopeId, principal);
        if (context.mcpReq.signal.aborted || this.stop.signal.aborted) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "timeout" });
        const rotating = destination && destination.secret !== params.delivery.secret;
        // Delivery can advance without changing the grant revision while the
        // challenge awaits. Preserve its event, ACK, attempts and retry state.
        const saved = ledger.save({
          ...current,
          id, jobId: job.jobId, scopeId, principal, verifiedAt, expiresAt, revision: (current?.revision || 0) + 1,
          disabled: undefined,
          destination: this.vault!.seal(id, { url: params.delivery.url, secret: params.delivery.secret,
            ...(rotating ? { previousSecret: destination!.secret, rotateUntil: verifiedAt + ROTATION_MS }
              : destination?.rotateUntil && destination.rotateUntil > verifiedAt ? { previousSecret: destination.previousSecret, rotateUntil: destination.rotateUntil } : {}) }),
          delivery: current?.delivery || "waiting", attempts: current?.attempts || 0, nextAttemptAt: current?.nextAttemptAt || 0
        }, current?.revision ?? 0);
        if (!saved) throw new ProtocolError(-32015, "CallbackEndpointError", { reason: "subscription_changed" });
        ledger.enqueue(job);
      });
      this.wake();
      return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
    } finally { this.verifying.delete(id); }
  }

  private authorize(context: ServerContext): string {
    if(this.nonforcingPinned)throw new Error('MCP_EVENTS_NONFORCING_PINNED');
    if (!this.principal || authenticatedMcpPrincipal(context) !== this.principal) throw this.denied();
    return this.principal;
  }

  private denied() { return new ProtocolError(-32001, "Events require an authenticated connection and the original conversation's owned Job."); }

  private requireJob(jobId: string, scopeId: string, principal: string): EventJob {
    const job = this.jobs.get(jobId);
    const activity = job && this.jobs.getActivity(job.activityId);
    const agent = job?.agentId && this.jobs.getAgent(job.agentId);
    if (!job || job.scopeId !== scopeId || job.mcpPrincipal !== principal ||
        activity?.scopeId !== scopeId || !agent || agent.scopeId !== scopeId ||
        job.projectId && !this.jobs.admissionStateStore.isEventProjectAvailable(job.projectId)) throw this.denied();
    const completion = this.jobs.admissionStateStore.getJobCompletionDelivery(jobId, scopeId);
    return { ...job, terminalVersion: completion?.terminalVersion, updatedAt: completion?.createdAt || job.updatedAt };
  }

  private identity(principal: string, scopeId: string, jobId: string, url: string): string {
    return "sub_" + createHash("sha256").update(JSON.stringify([principal, scopeId, JOB_TERMINAL_EVENT, { jobId }, url])).digest("hex");
  }

  wake(): void {
    if (this.stop.signal.aborted || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let deliveryFailed = false;
      this.running = Promise.resolve().then(()=>this.deliver()).catch(error => {
        deliveryFailed = true;this.nonforcingUnknown=true;this.retainedErrors.set('delivery',error);
      }).finally(() => {
        this.running = undefined;
        if (!this.stop.signal.aborted) {
          try {
            const now = Date.now();
            const deadlines = this.jobs.admissionStateStore.mcpEvents.list().flatMap(record => [
              Math.max(record.expiresAt, record.recoverUntil || 0),
              ...(!record.disabled && record.expiresAt > now && record.event && record.delivery === "pending" ? [record.nextAttemptAt] : [])
            ]);
            if (deadlines.length) {
              this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, Math.max(deliveryFailed ? 10_000 : 100, Math.min(...deadlines) - now));
              this.timer.unref();
            }
          } catch {
            // A state failure delays only delivery. No execution is inferred.
            this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, 10_000);
            this.timer.unref();
          }
        }
      });
    }, 0);
    this.timer.unref();
  }

  private async deliver(): Promise<void> {
    if(this.stop.signal.aborted)return;
    const ledger = this.jobs.admissionStateStore.mcpEvents;
    ledger.maintain();
    if(this.stop.signal.aborted)return;
    const records=ledger.list();
    if(this.stop.signal.aborted)return;
    for (const { jobId, id } of records) {
      if (this.stop.signal.aborted) break;
      // Another subscription's network await may have allowed this grant to
      // expire, renew or unsubscribe. The list supplies identities only.
      const record = ledger.get(jobId, id);
      if(this.stop.signal.aborted)break;
      if (!record || record.disabled || record.expiresAt <= Date.now() || record.delivery !== "pending" || record.nextAttemptAt > Date.now()) continue;
      if (!record.event) continue;
      if (record.attempts >= MAX_ATTEMPTS) { ledger.save({ ...record, delivery: "failed" }, record.revision); continue; }
      try { this.requireJob(record.jobId, record.scopeId, record.principal); if (record.principal !== this.principal) throw this.denied(); }
      catch (error) {
        if(this.stop.signal.aborted){this.retainedErrors.set(record.id,error);break;}
        // An unavailable state read is not evidence of revoked access.
        if (!(error instanceof ProtocolError)) throw error;
        ledger.save({ ...record, revision: record.revision + 1, disabled: "revoked" }, record.revision); continue;
      }
      if(this.stop.signal.aborted)break;
      let response;
      // Persist before opening keys or sending, including failed signing attempts.
      record.attempts += 1;
      if (!ledger.save(record, record.revision)) continue;
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
      const current = ledger.get(record.jobId, record.id);
      if (!current || current.revision !== record.revision || current.disabled || current.expiresAt <= Date.now() ||
          current.delivery !== "pending" || current.event?.eventId !== record.event.eventId) continue;
      const status = response.status;
      const acknowledged = status >= 200 && status < 300;
      const transient = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
      const failed = !acknowledged && (!transient || current.attempts >= MAX_ATTEMPTS);
      ledger.save({ ...current, lastStatus: status,
        delivery: acknowledged ? "acknowledged" : failed ? "failed" : "pending",
        ...(status === 410 ? { disabled: "gone" as const, revision: current.revision + 1 } : {}),
        ...(acknowledged ? { acknowledgedAt: Date.now() } : {}),
        nextAttemptAt: Date.now() + Math.min(60_000, 1_000 * 2 ** current.attempts)
      }, current.revision);
    }
  }

  async close(): Promise<void> {
    if(this.nonforcingPinned){if(!(await this.closeNonforcing()).exited)throw new Error('NONFORCING_SHUTDOWN_UNCONFIRMED');return;}
    this.ordinaryClose=true;this.stop.abort();this.unsubscribe();if(this.timer)clearTimeout(this.timer);await this.running;
  }
}
