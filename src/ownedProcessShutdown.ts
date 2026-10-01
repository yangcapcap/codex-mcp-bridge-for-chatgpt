import type {ChildProcess} from "node:child_process";
import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {snapshotExecutionShutdownRequest,snapshotExecutionShutdownReceipt,type ExecutionShutdownRequest} from "./executionShutdownProtocol.js";
import {boundedShutdown,combineShutdown,snapshotShutdownPolicy,shutdownResult,type ShutdownPolicy,type ShutdownResult} from "./shutdown.js";

type Lifetime={pinned:boolean;ordinary:boolean};
const lifetimes=new WeakMap<ChildProcess,Lifetime>();
function lifetime(child:ChildProcess):Lifetime {
 let state=lifetimes.get(child);
 if(!state){state={pinned:false,ordinary:false};lifetimes.set(child,state);}
 return state;
}
/** Call immediately before any ordinary close/force action on this owned handle. */
export function beginOrdinaryOwnedProcessStop(child:ChildProcess):boolean {
 const state=lifetime(child);
 if(state.pinned)return false;
 state.ordinary=true;return true;
}
export function isOwnedProcessNonforcing(child:ChildProcess):boolean{return lifetime(child).pinned;}

type Hooks=Readonly<{generation():string|undefined;pin():true}>;
type CloseRequest=Extract<ExecutionShutdownRequest,{type:"close-nonforcing"}>;
/** Controller for an already spawned private Node IPC child. The child-side
 * receipt must cover its own resources/children. This is not process-tree or
 * external-runtime authority, and must not be used with a reattached PID. */
export class OwnedProcessShutdown {
 private readonly hooks:Hooks;
 private initial?:Promise<ShutdownResult>;
 private settled=false;
 private uncertain=false;
 private request?:CloseRequest;
 private finalReceipt?:ShutdownResult;
 private readonly issued=new Map<string,ExecutionShutdownRequest>();
 private readonly received=new Map<string,ShutdownResult>();
 private readonly waiting=new Map<string,(result:ShutdownResult)=>void>();
 constructor(private readonly child:ChildProcess,hooks:Hooks,private readonly controllerId=randomUUID()){
  const descriptors=Object.getOwnPropertyDescriptors(hooks);
  const keys=["generation","pin"];
  if(Reflect.ownKeys(descriptors).length!==2 || keys.some(key=>!Object.hasOwn(descriptors,key) ||
    !Object.hasOwn(descriptors[key],"value") || typeof descriptors[key].value!=="function"))
   throw new Error("OWNED_SHUTDOWN_CAPABILITY_INVALID");
  this.hooks=Object.freeze(Object.fromEntries(keys.map(key=>[key,Function.prototype.bind.call(descriptors[key].value,hooks)]))) as Hooks;
  child.on("message",value=>this.receive(value));
 }
 get pinned():boolean{return isOwnedProcessNonforcing(this.child);}
 closeNonforcing(policy:ShutdownPolicy):Promise<ShutdownResult>{
  const snapshot=snapshotShutdownPolicy(policy);
  if(snapshot.allowSigkillEscalation!==false)throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
  if(this.initial)return this.initial;
  let resolve!:(result:ShutdownResult)=>void;
  this.initial=new Promise(done=>{resolve=done;});
  const state=lifetime(this.child);this.uncertain=state.ordinary;state.pinned=true;
  const requestId=randomUUID();
  try{
   if(this.hooks.pin()!==true)throw new Error("OWNED_SHUTDOWN_FENCE_UNCONFIRMED");
   const request=snapshotExecutionShutdownRequest({type:"close-nonforcing",generation:this.hooks.generation(),
    ownerPid:this.child.pid,controllerId:this.controllerId,requestId,closeRequestId:requestId,
    policy:{...snapshot,allowSigkillEscalation:false}});
   if(request?.type==="close-nonforcing")this.request=request;
   else this.uncertain=true;
  }catch{this.uncertain=true;}
  const deadline=snapshot.graceMs*2+6000;
  void boundedShutdown(async()=>this.finish(this.request?await this.exchange(this.request,deadline):shutdownResult("uncertain"),deadline),
   Math.min(180000,deadline*3)).then(result=>{this.settled=true;resolve(result);},()=>{
    this.settled=true;resolve(shutdownResult("uncertain"));
   });
  return this.initial;
 }
 async observeNonforcingExit():Promise<ShutdownResult>{
  if(!this.settled || !this.request)return shutdownResult("uncertain");
  if(this.uncertain)return this.measure(this.finalReceipt ?? shutdownResult("uncertain"),6000);
  if(this.finalReceipt)return this.measure(this.finalReceipt,6000);
  const {policy,...original}=this.request;
  const request=snapshotExecutionShutdownRequest({...original,type:"observe-nonforcing",requestId:randomUUID()});
  if(!request)return shutdownResult("uncertain");
  return boundedShutdown(async()=>this.finish(await this.exchange(request,6000),6000),18000);
 }
 /** Ordinary wrappers can report the initial result without reopening force. */
 async closeAfterPin():Promise<void>{
  if(this.uncertain || !this.initial || !(await this.initial).exited || this.uncertain)throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
 }
 private exchange(request:ExecutionShutdownRequest,deadline:number):Promise<ShutdownResult>{
  if(this.child.pid!==request.ownerPid){this.uncertain=true;return Promise.resolve(shutdownResult("uncertain"));}
  if(!this.child.connected || this.issued.size>=128)return Promise.resolve(shutdownResult("uncertain"));
  return new Promise(resolve=>{
   let settled=false;
   const finish=(result:ShutdownResult)=>{if(settled)return;settled=true;clearTimeout(timer);this.waiting.delete(request.requestId);resolve(result);};
   const timer=setTimeout(()=>finish(shutdownResult("uncertain")),deadline);
   this.issued.set(request.requestId,request);this.waiting.set(request.requestId,finish);
   try{
    // Node IPC backpressure false still means queued delivery; the callback,
    // exact receipt or bounded deadline determines the observation.
    this.child.send(request,error=>{if(error)finish(shutdownResult("uncertain"));});
   }catch{finish(shutdownResult("uncertain"));}
  });
 }
 private receive(value:unknown):void{
  for(const [id,request] of this.issued){
   const receipt=snapshotExecutionShutdownReceipt(value,request);
   if(!receipt)continue;
   const previous=this.received.get(id);
   if(previous && JSON.stringify(previous)!==JSON.stringify(receipt.result)){
    this.uncertain=true;this.waiting.get(id)?.(shutdownResult("uncertain"));return;
   }
   this.received.set(id,receipt.result);
   if(request.type==="finalize-nonforcing" && receipt.result.exited)this.finalReceipt=receipt.result;
   this.waiting.get(id)?.(receipt.result);return;
  }
 }
 private async finish(resources:ShutdownResult,deadline:number):Promise<ShutdownResult>{
  if(resources.exited && !this.uncertain && this.request && !this.finalReceipt){
   const {policy,...original}=this.request;
   const request=snapshotExecutionShutdownRequest({...original,type:"finalize-nonforcing",requestId:randomUUID()});
   if(request)resources=await this.exchange(request,deadline);
  }
  return this.measure(this.finalReceipt ?? resources,deadline);
 }
 private async measure(resources:ShutdownResult,deadline:number):Promise<ShutdownResult>{
  const owner=await boundedShutdown(async()=>{
   const end=performance.now()+deadline;
   for(;;){
    if(!this.request || this.child.pid!==this.request.ownerPid){this.uncertain=true;return shutdownResult("uncertain");}
    if(this.child.exitCode!==null || this.child.signalCode!==null)return shutdownResult("exited");
    if(!resources.exited || !this.finalReceipt || performance.now()>=end)return shutdownResult("timeout",1);
    await new Promise(done=>setTimeout(done,20));
   }
  },deadline+100);
  return combineShutdown([owner,resources,...(this.uncertain?[shutdownResult("uncertain")]:[])]);
 }
}
