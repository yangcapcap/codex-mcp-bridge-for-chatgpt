import {types} from 'node:util';
import {RuntimeOperationFence} from './runtimeOperationFence.js';
import {boundedShutdown,combineShutdown,snapshotShutdownPolicy,shutdownResult,type ShutdownPolicy,type ShutdownResult} from './shutdown.js';
export type RuntimeResourceHooks=Readonly<{pin():true;close(policy:ShutdownPolicy):Promise<ShutdownResult>;observe():ShutdownResult|Promise<ShutdownResult>}>;
type Entry={hooks:RuntimeResourceHooks;fence:RuntimeOperationFence;initial?:Promise<ShutdownResult>};
/** Resource quiescence for one newly constructed state owner. Database closure
 * remains a final caller-owned step; this never grants durable writer release. */
export class RuntimeResourceShutdown {
 private readonly entries=new Map<string,Entry>();
 private readonly expected:Set<string>;
 private policy?:Required<ShutdownPolicy>;
 private ready=false;
 private uncertain=false;
 private pinComplete=false;
 private initial?:Promise<ShutdownResult>;
 readonly operations=new RuntimeOperationFence();
 readonly retained=new Map<string,unknown>();
 constructor(names:readonly string[]){this.expected=new Set(names);if(!names.length||this.expected.size!==names.length)throw new Error('RUNTIME_RESOURCE_PLAN_INVALID');}
 get pinned():boolean{return this.policy!==undefined;}
 invalidate(reason:string,value:unknown):void{this.uncertain=true;if(this.retained.size<128)this.retained.set(reason,value);}
 register(name:string,hooks:RuntimeResourceHooks):void {
  if(!this.expected.has(name)||this.entries.has(name)){this.invalidate(name,hooks);throw new Error('RUNTIME_RESOURCE_REGISTRATION_INVALID');}
  if(types.isProxy(hooks)){this.invalidate(name,hooks);throw new Error('RUNTIME_RESOURCE_CAPABILITY_INVALID');}
  const d=Object.getOwnPropertyDescriptors(hooks),keys=['pin','close','observe'];
  if(Reflect.ownKeys(d).length!==3||keys.some(k=>!Object.hasOwn(d,k)||!Object.hasOwn(d[k],'value')||typeof d[k].value!=='function')){
   this.invalidate(name,hooks);throw new Error('RUNTIME_RESOURCE_CAPABILITY_INVALID');
  }
  const captured=Object.freeze(Object.fromEntries(keys.map(k=>[k,Function.prototype.bind.call(d[k].value,hooks)]))) as RuntimeResourceHooks;
  const entry:Entry={hooks:captured,fence:new RuntimeOperationFence()};this.entries.set(name,entry);
  if(this.pinned){this.invalidate('late-construction:'+name,hooks);this.pinEntry(name,entry);this.startEntry(name,entry);}
 }
 sealReady():void {if(this.pinned){this.invalidate('late-readiness',true);return;}if(this.entries.size!==this.expected.size)throw new Error('RUNTIME_RESOURCE_PLAN_INCOMPLETE');this.ready=true;}
 pin(policy:ShutdownPolicy):true {
  const supplied=snapshotShutdownPolicy(policy);if(supplied.allowSigkillEscalation!==false)throw new Error('NONFORCING_SHUTDOWN_POLICY_REQUIRED');
  if(this.pinned){if(!this.pinComplete)throw new Error('NONFORCING_SHUTDOWN_PIN_UNCONFIRMED');return true;}
  this.policy=supplied;this.operations.pinNonforcingShutdown();if(!this.ready)this.invalidate('startup-incomplete',this.entries.size);
  // Attempt all independent resource pins before any close await.
  for(const [name,entry] of this.entries)this.pinEntry(name,entry);
  for(const [name,entry] of this.entries)this.startEntry(name,entry);
  this.pinComplete=true;return true;
 }
 private pinEntry(name:string,entry:Entry):void{try{if(entry.hooks.pin()!==true)this.invalidate('pin:'+name,false);}catch(error){this.invalidate('pin:'+name,error);}}
 private startEntry(name:string,entry:Entry):void {
  if(entry.initial||!this.policy)return;
  let finish!:(value:ShutdownResult)=>void;entry.initial=new Promise(resolve=>finish=resolve);
  const result=entry.fence.run(()=>{
   const value=entry.hooks.close(this.policy!);this.retained.set('close-source:'+name,value);return value;
  }).then(value=>{this.retained.set('close-result:'+name,value);return value;},error=>{
   this.invalidate('close-error:'+name,error);throw error;
  });entry.fence.pinNonforcingShutdown();
  void boundedShutdown(()=>result,this.policy.graceMs*2+6000).then(value=>{
   if(value.outcome==='uncertain')this.invalidate('close:'+name,value);finish(value);
  });
 }
 close(policy:ShutdownPolicy):Promise<ShutdownResult> {
  const supplied=snapshotShutdownPolicy(policy);if(supplied.allowSigkillEscalation!==false)throw new Error('NONFORCING_SHUTDOWN_POLICY_REQUIRED');
  if(this.initial)return this.initial;
  let finish!:(value:ShutdownResult)=>void;this.initial=new Promise(resolve=>finish=resolve);
  try{this.pin(supplied);}catch(error){this.invalidate('owner-pin',error);finish(shutdownResult('uncertain'));return this.initial;}
  void boundedShutdown(async()=>{await Promise.all([...this.entries.values()].map(e=>e.initial));return this.observe();},supplied.graceMs*2+6500).then(finish);
  return this.initial;
 }
 async observe():Promise<ShutdownResult> {
  if(!this.pinned||!this.pinComplete||this.uncertain||this.entries.size!==this.expected.size)return shutdownResult('uncertain');
  const resources:ShutdownResult[]=[this.operations.observeNonforcingExit()];
  for(const [name,entry] of this.entries){
   resources.push(entry.fence.observeNonforcingExit());
   const observer=new RuntimeOperationFence();
   const observation=observer.run(()=>{
    const value=entry.hooks.observe();this.retained.set('observe-source:'+name,value);return value;
   }).then(value=>{this.retained.set('observe-result:'+name,value);return value;},error=>{
    this.invalidate('observe-error:'+name,error);throw error;
   });observer.pinNonforcingShutdown();
   const measured=await boundedShutdown(()=>observation);
   if(observer.observeNonforcingExit().outcome==='uncertain')this.invalidate('observer-fence:'+name,observer);
   if(measured.outcome==='uncertain')this.invalidate('observe:'+name,measured);resources.push(measured);
  }
  return this.uncertain?shutdownResult('uncertain'):combineShutdown(resources);
 }
}
