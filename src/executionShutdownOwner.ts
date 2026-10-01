import {snapshotExecutionShutdownRequest,type ExecutionShutdownRequest,type ExecutionShutdownReceipt} from "./executionShutdownProtocol.js";
import {boundedShutdown,shutdownResult,type ShutdownResult} from "./shutdown.js";
type CloseRequest=Extract<ExecutionShutdownRequest,{type:"close-nonforcing"}>;
type Hooks=Readonly<{
 pin(policy:CloseRequest["policy"]):true;
 close(policy:CloseRequest["policy"]):Promise<ShutdownResult>;
 observe():Promise<ShutdownResult>;
}>;
const sameOwner=(a:ExecutionShutdownRequest,b:ExecutionShutdownRequest)=>a.generation===b.generation &&
 a.ownerPid===b.ownerPid && a.controllerId===b.controllerId && a.closeRequestId===b.closeRequestId;

/** Authenticated local control correlation. No receipt alone proves owner exit. */
export class ExecutionShutdownOwner {
 private initial?:CloseRequest;
 private initialResult?:Promise<ShutdownResult>;
 private ordinaryHistory=false;
 private uncertain=false;
 private readonly hooks:Hooks;
 private readonly replies=new Map<string,{request:ExecutionShutdownRequest;reply:Promise<ExecutionShutdownReceipt>}>();
 constructor(private readonly generation:string,private readonly pid:number,hooks:Hooks) {
  const d=Object.getOwnPropertyDescriptors(hooks),keys=["pin","close","observe"];
  if(Reflect.ownKeys(d).length!==3 || keys.some(k=>!Object.hasOwn(d,k)||!Object.hasOwn(d[k],"value")||typeof d[k].value!=="function"))
   throw new Error("EXECUTION_SHUTDOWN_CAPABILITY_INVALID");
  this.hooks=Object.freeze(Object.fromEntries(keys.map(k=>[k,Function.prototype.bind.call(d[k].value,hooks)]))) as Hooks;
 }
 get pinned():boolean{return this.initial!==undefined;}
 get finalizationAllowed():boolean{return this.pinned && !this.uncertain;}
 invalidateObservation():void{this.uncertain=true;}
 markOrdinaryShutdown():void{this.ordinaryHistory=true;if(this.pinned)this.uncertain=true;}
 handle(value:unknown,authenticatedControllerId:string):Promise<ExecutionShutdownReceipt|undefined> {
  const request=snapshotExecutionShutdownRequest(value);
  if(!request || request.generation!==this.generation || request.ownerPid!==this.pid ||
    request.controllerId!==authenticatedControllerId)return Promise.resolve(undefined);
  if(!this.initial) {
   if(request.type!=="close-nonforcing")return Promise.resolve(undefined);
   this.initial=request;this.uncertain=this.ordinaryHistory;
   let resolve!:(result:ShutdownResult)=>void;
   this.initialResult=new Promise(done=>{resolve=done;});
   // Seal the promise and owner correlation before a synchronous hook reenters.
   let acknowledged=false;
   try{acknowledged=this.hooks.pin(request.policy)===true;}catch{ /* Missing fence never authorizes a close action. */ }
   if(!acknowledged){this.uncertain=true;resolve(shutdownResult("uncertain"));}
   else void boundedShutdown(()=>this.hooks.close(request.policy),request.policy.graceMs*2+6000).then(result=>{
    resolve(this.uncertain?shutdownResult("uncertain",result.survivors,result.signalFailures,result.identityChanges):result);
   },()=>resolve(shutdownResult("uncertain")));
  }
  if(!sameOwner(request,this.initial) || request.type==="close-nonforcing" &&
    (request.requestId!==this.initial.requestId || request.policy.graceMs!==this.initial.policy.graceMs))return Promise.resolve(undefined);
  const prior=this.replies.get(request.requestId);
  if(prior)return prior.request.type===request.type ? prior.reply : Promise.resolve(undefined);
  if(this.replies.size>=128)return Promise.resolve(undefined);
  let resolve!:(receipt:ExecutionShutdownReceipt)=>void;
  const reply=new Promise<ExecutionShutdownReceipt>(done=>{resolve=done;});
  this.replies.set(request.requestId,{request,reply});
  const result=request.type==="close-nonforcing" ? this.initialResult! :
   boundedShutdown(async()=>{await this.initialResult;return this.uncertain?shutdownResult("uncertain"):this.hooks.observe();});
  void result.then(measured=>resolve(Object.freeze({generation:request.generation,ownerPid:request.ownerPid,
   controllerId:request.controllerId,requestId:request.requestId,closeRequestId:request.closeRequestId,
   type:"shutdown-receipt",operation:request.type,result:this.uncertain ?
    shutdownResult("uncertain",measured.survivors,measured.signalFailures,measured.identityChanges):measured})));
  return reply;
 }
}
