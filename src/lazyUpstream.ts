import type { CodexBackendKind } from "./config.js";
import type { BackendCapabilities } from "./modelPolicy.js";
import type { CodexUpstream } from "./upstream.js";

import {boundedShutdown,combineShutdown,shutdownResult,snapshotShutdownPolicy,type ShutdownPolicy,type ShutdownResult} from "./shutdown.js";

type Args<K extends keyof CodexUpstream> = Parameters<NonNullable<CodexUpstream[K]>>;

/** Defers environment admission until this backend is actually used. */
export class LazyCodexUpstream implements CodexUpstream {
  private instance?: CodexUpstream;
  private starting?: Promise<CodexUpstream>;
  private closed = false;
  private closing?: Promise<void>;
  private nonforcingClose?:Promise<ShutdownResult>;
  private nonforcingSettled=false;
  private nonforcingUncertain=false;
  private nonforcingPolicy?:ShutdownPolicy & {allowSigkillEscalation:false};
  private instanceClose?:Promise<ShutdownResult>;
  private capturedObserver?:()=>ShutdownResult|Promise<ShutdownResult>;
  private readonly pendingResumeProtections = new Set<string>();
  constructor(private readonly kind: CodexBackendKind, private readonly features: BackendCapabilities,
    private readonly factory: () => Promise<CodexUpstream>, private readonly dispose?: () => Promise<void>, private readonly guard?: () => void | Promise<void>, private readonly pinFactory?:()=>true) {}

  async recoverExecution(...args: Args<"recoverExecution">) { return (await this.method("recoverExecution"))(...args); }
  async acknowledgeExecution(...args: Args<"acknowledgeExecution">) { return (await this.method("acknowledgeExecution"))(...args); }
  ownsActiveExecution(...args: Args<"ownsActiveExecution">): boolean {
    return this.instance?.ownsActiveExecution?.(...args) === true;
  }
  ownsRetainedResult(...args: Args<"ownsRetainedResult">): boolean {
    return this.instance?.ownsRetainedResult?.(...args) === true;
  }
  async detachExecution() {
    this.assertOpen();await this.starting?.catch(() => {});this.assertOpen();
    const instance=this.instance,method=instance?.detachExecution;this.assertOpen();
    if(method)await Reflect.apply(method,instance,[]);
  }
  capabilities(): BackendCapabilities { return this.instance?.capabilities?.(this.kind) || this.features; }
  async prepareExecution(...args: Args<"prepareExecution">) { return (await this.method("prepareExecution"))(...args); }
  listTools() {
    this.assertOpen();const instance=this.instance,method=instance?.listTools;this.assertOpen();
    return method ? Reflect.apply(method,instance,[]) : Promise.resolve({backendKind:this.kind,initialized:false,capabilities:this.features});
  }
  async callTool(...args:Args<"callTool">) {
    const instance=await this.get();await this.guard?.();this.assertOpen();
    const method=instance.callTool;this.assertOpen();return Reflect.apply(method,instance,args);
  }
  async listModels(...args: Args<"listModels">) { return (await this.method("listModels"))(...args); }
  async readAccountSnapshot() { return (await this.method("readAccountSnapshot"))(); }
  async readAuthenticationPolicy() { return (await this.method("readAuthenticationPolicy"))(); }
  async readAccountRateLimits() { return (await this.method("readAccountRateLimits"))(); }
  async startThread(...args: Args<"startThread">) { return (await this.method("startThread"))(...args); }
  async continueThread(...args: Args<"continueThread">) { return (await this.method("continueThread"))(...args); }
  async forkThread(...args: Args<"forkThread">) { return (await this.method("forkThread"))(...args); }
  async archiveThread(...args: Args<"archiveThread">) { return (await this.method("archiveThread"))(...args); }
  async restoreThread(...args: Args<"restoreThread">) { return (await this.method("restoreThread"))(...args); }
  async probeThread(...args: Args<"probeThread">) { return (await this.method("probeThread"))(...args); }
  async releaseThreadConnection(...args: Args<"releaseThreadConnection">) { return (await this.method("releaseThreadConnection"))(...args); }
  protectThreadFromImplicitResume(threadId: string): void {
    this.assertOpen();
    const instance=this.instance,method=instance?.protectThreadFromImplicitResume;this.assertOpen();
    if(instance){if(method)Reflect.apply(method,instance,[threadId]);}
    else this.pendingResumeProtections.add(threadId);
  }
  async listBackgroundTerminals(...args: Args<"listBackgroundTerminals">) { return (await this.method("listBackgroundTerminals"))(...args); }
  async listLoadedBackgroundTerminals(...args:Args<"listLoadedBackgroundTerminals">) {
    this.assertOpen();const instance=this.instance,method=instance?.listLoadedBackgroundTerminals;this.assertOpen();
    return method ? Reflect.apply(method,instance,args) : null;
  }
  async terminateBackgroundTerminal(...args: Args<"terminateBackgroundTerminal">) { return (await this.method("terminateBackgroundTerminal"))(...args); }
  async forceTerminateWorker(...args: Args<"forceTerminateWorker">) { return (await this.method("forceTerminateWorker"))(...args); }
  async respondToInteraction(...args: Args<"respondToInteraction">) { return (await this.method("respondToInteraction"))(...args); }
  interactionInput(...args: Args<"interactionInput">) { return this.instance?.interactionInput?.(...args); }
  async steerThread(...args: Args<"steerThread">) { return (await this.method("steerThread"))(...args); }
  canResumeThread(...args: Args<"canResumeThread">) { return this.instance?.canResumeThread?.(...args); }
  canSteerThread(...args: Args<"canSteerThread">) { return this.instance?.canSteerThread?.(...args) === true; }

  async close(): Promise<void> {
    if(this.nonforcingClose)return this.reportInitialClose();
    this.closed = true;
    return this.closing ||= (async () => {
      try {
        await this.starting?.catch(() => undefined);
        if(this.nonforcingClose)return this.reportInitialClose();
        await this.instance?.close();
      }finally{if(!this.nonforcingClose)await this.dispose?.();}
      if(this.nonforcingClose)return this.reportInitialClose();
    })();
  }
  closeNonforcing(policy:ShutdownPolicy & {allowSigkillEscalation:false}):Promise<ShutdownResult>{
    const snapshot=snapshotShutdownPolicy(policy);
    if(snapshot.allowSigkillEscalation!==false)throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    if(this.nonforcingClose)return this.nonforcingClose;
    let seal!:(result:ShutdownResult)=>void;
    this.nonforcingClose=new Promise(resolve=>{seal=resolve;});
    this.closed=true;
    this.nonforcingPolicy=Object.freeze({...snapshot,allowSigkillEscalation:false});
    // An unfinished factory cannot reconstruct workers/resources already born
    // before their wrapper was registered. Retain that gap even after arrival.
    this.nonforcingUncertain=Boolean(this.closing || this.starting || this.dispose);
    try{if(this.pinFactory && this.pinFactory()!==true)this.nonforcingUncertain=true;}
    catch{this.nonforcingUncertain=true;}
    if(this.instance)this.pinInstance(this.instance);
    const starting=this.starting;
    void boundedShutdown(async()=>{
      await starting?.catch(()=>{this.nonforcingUncertain=true;});
      const resource=this.instanceClose ? await this.instanceClose : shutdownResult("exited");
      return this.nonforcingUncertain ? combineShutdown([resource,shutdownResult("uncertain")]) : resource;
    },snapshot.graceMs*2+6000).then(result=>{this.nonforcingSettled=true;seal(result);});
    return this.nonforcingClose;
  }
  async observeNonforcingExit():Promise<ShutdownResult>{
    if(!this.nonforcingSettled || this.nonforcingUncertain)return shutdownResult("uncertain");
    if(!this.instance)return shutdownResult("exited");
    return boundedShutdown(async()=>this.capturedObserver ? this.capturedObserver() : shutdownResult("uncertain"));
  }
  private pinInstance(instance:CodexUpstream):void{
    if(this.instanceClose || !this.nonforcingPolicy)return;
    let seal!:(result:ShutdownResult)=>void;
    this.instanceClose=new Promise(resolve=>{seal=resolve;});
    let operation:Promise<ShutdownResult>;
    try{
      const close=instance.closeNonforcing;
      if(typeof close!=="function")this.nonforcingUncertain=true;
      operation=typeof close==="function" ? Promise.resolve(close.call(instance,this.nonforcingPolicy)) : Promise.resolve(shutdownResult("uncertain"));
      const observe=instance.observeNonforcingExit;
      this.capturedObserver=typeof observe==="function" ? observe.bind(instance) : undefined;
    }catch{this.nonforcingUncertain=true;operation=Promise.resolve(shutdownResult("uncertain"));}
    void boundedShutdown(()=>operation,this.nonforcingPolicy.graceMs!*2+6000).then(seal);
  }
  private async reportInitialClose():Promise<void>{
    if(!this.nonforcingClose || !(await this.nonforcingClose).exited)throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
  }
  private assertOpen():void{if(this.closed)throw new Error("Codex backend is closed.");}
  private async get(): Promise<CodexUpstream> {
    if (this.closed) throw new Error("Codex backend is closed.");
    if (this.instance) return this.instance;
    if (!this.starting) this.starting = Promise.resolve().then(()=>{this.assertOpen();return this.factory();}).then(instance => {
      this.instance=instance;
      if(this.nonforcingClose){this.pinInstance(instance);return instance;}
      for(const threadId of this.pendingResumeProtections){
        const method=instance.protectThreadFromImplicitResume;this.assertOpen();
        if(method)Reflect.apply(method,instance,[threadId]);
      }
      this.pendingResumeProtections.clear();
      this.instance = instance;
      return instance;
    })
      .finally(() => { this.starting = undefined; });
    const instance = await this.starting;
    if (this.closed) throw new Error("Codex backend is closed.");
    return instance;
  }
  private async method<K extends keyof CodexUpstream>(name: K): Promise<NonNullable<CodexUpstream[K]>> {
    const instance = await this.get();
    if (["prepareExecution", "startThread", "continueThread", "forkThread"].includes(name)) await this.guard?.();
    const method = instance[name];
    if (typeof method !== "function") throw new Error(`Codex backend ${this.kind} does not support ${name}.`);
    this.assertOpen();
    return ((...args:unknown[])=>{this.assertOpen();return Function.prototype.apply.call(method,instance,args);}) as NonNullable<CodexUpstream[K]>;
  }
}
