import type {JsonRpcProcessIdentity} from "./jsonRpcProcess.js";
import {SupervisedProcessTreeRegistry} from "./processTreeSupervisor.js";
import {shutdownResult} from "./shutdown.js";
import {snapshotWorkerShutdownBinding,type WorkerShutdownBinding,type WorkerShutdownReceipt,type WorkerShutdownSupervisor} from "./workerShutdownReceipt.js";

const MAX_ASSOCIATIONS=4096;
const key=(binding:WorkerShutdownBinding)=>`${binding.ownerId}:${binding.workerId}:${binding.workerGeneration}`;
const same=(a:WorkerShutdownBinding,b:WorkerShutdownBinding)=>a.ownerId===b.ownerId && a.workerId===b.workerId &&
 a.workerGeneration===b.workerGeneration && a.pid===b.pid && a.processGroupId===b.processGroupId;
function matchesIdentity(value:JsonRpcProcessIdentity,binding:WorkerShutdownBinding):boolean {
 try {
  if(!value || typeof value!=="object")return false;
  const d=Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(d).length===2 && ["pid","processGroupId"].every(k=>Object.hasOwn(d,k)&&Object.hasOwn(d[k],"value")) &&
   d.pid.value===binding.pid && d.processGroupId.value===binding.processGroupId;
 }catch{return false;}
}
type Registration={binding:WorkerShutdownBinding;root:Readonly<JsonRpcProcessIdentity>;ready:boolean;uncertain:boolean;completion:Promise<void>};

/** Trusted spawn callbacks establish correlation before shutdown. Receipts only
 * describe local observed trees; they are not external or authenticated IPC proof. */
export class WorkerTreeShutdownSupervisor {
 private readonly registrations=new Map<string,Registration>();
 private ownerId?:string;
 private pinned=false;
 private uncertain=false;
 readonly supervisor:WorkerShutdownSupervisor;
 constructor(private readonly registry:SupervisedProcessTreeRegistry) {
  this.supervisor=Object.freeze({
   pinNonforcingShutdown:(binding:WorkerShutdownBinding)=>this.pin(binding),
   closeNonforcing:(binding:WorkerShutdownBinding)=>this.observe(binding),
   observeNonforcingExit:(binding:WorkerShutdownBinding)=>this.observe(binding)
  });
 }
 /** Records the owned root synchronously. Probe failure retains UNKNOWN and
  * completes normally so process-table availability is not an admission gate. */
 register(identity:JsonRpcProcessIdentity,value:WorkerShutdownBinding):Promise<void> {
  const binding=snapshotWorkerShutdownBinding(value);
  if(!binding || !matchesIdentity(identity,binding))
   throw new Error("WORKER_TREE_REGISTRATION_INVALID");
  const root=Object.freeze({pid:binding.pid,processGroupId:binding.processGroupId});
  this.registry.remember(root,true);
  this.ownerId ??= binding.ownerId;
  if(binding.ownerId!==this.ownerId){this.uncertain=true;throw new Error("WORKER_TREE_OWNER_CHANGED");}
  const prior=this.registrations.get(key(binding));
  if(prior) {
   if(!same(prior.binding,binding)){this.uncertain=true;throw new Error("WORKER_TREE_GENERATION_CHANGED");}
   return prior.completion;
  }
  if(this.registrations.size>=MAX_ASSOCIATIONS){this.uncertain=true;return Promise.resolve();}
  // A reused numeric root must never borrow an older generation's tree ledger.
  if([...this.registrations.values()].some(r=>r.root.pid===root.pid)) {
   this.uncertain=true;throw new Error("WORKER_TREE_ROOT_REUSED");
  }
  const record:Registration={binding,root,ready:false,uncertain:this.pinned,completion:Promise.resolve()};
  this.registrations.set(key(binding),record);
  record.completion=this.registry.register(root).then(()=>{record.ready=true;},()=>{record.uncertain=true;});
  return record.completion;
 }
 /** Exact source callback observation; wrong/missing generation cannot mark a root exited. */
 markExited(identity:JsonRpcProcessIdentity,value:WorkerShutdownBinding):void {
  const record=this.registration(value);
  if(!record || !matchesIdentity(identity,record.binding)) {
   this.uncertain=true;return;
  }
  this.registry.markExited(record.root);
 }
 private registration(value:WorkerShutdownBinding):Registration|undefined {
  const binding=snapshotWorkerShutdownBinding(value);
  const record=binding && this.registrations.get(key(binding));
  return record && binding && same(record.binding,binding) ? record : undefined;
 }
 private pin(value:WorkerShutdownBinding):true {
  this.pinned=true;this.registry.pinNonforcingShutdown();
  const record=this.registration(value);
  if(!record || !record.ready || record.uncertain || this.uncertain) {
   if(record)record.uncertain=true;
   throw new Error("WORKER_TREE_FENCE_UNCONFIRMED");
  }
  return true;
 }
 private async observe(value:WorkerShutdownBinding):Promise<WorkerShutdownReceipt> {
  const binding=snapshotWorkerShutdownBinding(value);
  if(!binding)throw new Error("WORKER_TREE_RECEIPT_BINDING_INVALID");
  const record=this.registration(binding);
  const result=this.pinned && !this.uncertain && record?.ready && !record.uncertain ?
   await this.registry.observeNonforcingTreeExit(record.root) : shutdownResult("uncertain");
  // A lifetime callback may report an association fault while the probe yields.
  return Object.freeze({binding,result:this.uncertain || record?.uncertain ? shutdownResult("uncertain") : result});
 }
}
