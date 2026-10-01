import {test,expect,vi} from 'vitest';
import {BridgeStateStore} from '../src/stateStore.js';
import {AutomaticRecoveryController} from '../src/automaticRecovery.js';
import {ThreadConnectionController} from '../src/threadConnections.js';
import {StateMaintenanceScheduler} from '../src/maintenanceScheduler.js';
// Copied independent 6a5c3a6 baseline; root evidence is the isolated runner log.
function record(_label:string,_data:unknown):void {}
const candidate={key:'fresh-candidate',scopeId:'fresh-scope',agentId:'fresh-agent',kind:'recheck' as const};
test.each(['key','scopeId','agentId','kind','jobId'])('fresh candidate descriptor %s pin stops subsequent fields and writes',async field=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;const visited:string[]=[];
 const data={...candidate,jobId:'fresh-job'};const proxy=new Proxy(data,{getOwnPropertyDescriptor(target,key){visited.push(String(key));if(key===field)owner.pinNonforcingShutdown();return Reflect.getOwnPropertyDescriptor(target,key);}});
 const attempt=vi.fn(async()=>({resolved:true,reason:'success',evidence:'fresh'}));owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[proxy],attempt});
 try{await owner.sweep();record('descriptor-'+field,{visited,rows:state.automaticRecovery.list(),resource:owner.observeNonforcingExit()});expect(visited.at(-1)).toBe(field);expect(attempt).not.toHaveBeenCalled();expect(state.automaticRecovery.list()).toEqual([]);expect(owner.observeNonforcingExit().exited).toBe(true);}finally{await owner.close();state.close();}
});
test.each(['hole','oversize','revoked','inherited-field'])('fresh invalid discovery %s is sticky unknown without pin fabrication',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let reads=0;let value:any;
 if(kind==='hole')value=new Array(1);
 if(kind==='oversize'){value=new Array(4097);Object.defineProperty(value,'0',{get(){reads++;return candidate;}});}
 if(kind==='revoked'){const x=Proxy.revocable([candidate],{});x.revoke();value=x.proxy;}
 if(kind==='inherited-field')value=[Object.assign(Object.create({scopeId:'inherited'}),{key:'fresh-candidate',agentId:'fresh-agent',kind:'recheck'})];
 const attempt=vi.fn(async()=>({resolved:true,reason:'success'}));const owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>value,attempt});
 try{await owner.sweep();expect((owner as any).nonforcingPinned).toBe(false);owner.pinNonforcingShutdown();record('invalid-'+kind,{reads,rows:state.automaticRecovery.list(),resource:owner.observeNonforcingExit()});expect(reads).toBe(0);expect(attempt).not.toHaveBeenCalled();expect(state.automaticRecovery.list()).toEqual([]);if(kind==='revoked'){expect(owner.lastError).toBeDefined();expect(owner.observeNonforcingExit().exited).toBe(true);}else expect(owner.observeNonforcingExit().outcome).toBe('uncertain');}finally{await owner.close();state.close();}
});
test.each(['page','job','enabled','thread-protection','maintenance-completed'])('fresh %s callable call getter cannot delegate after pin',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let owner:any;let calls=0,lookups=0;
 const body=()=>{calls++;return kind==='page'?[]:kind==='enabled'?true:undefined;};
 Object.defineProperty(body,'call',{get(){lookups++;owner.pinNonforcingShutdown();return function(receiver:unknown,...args:unknown[]){return Reflect.apply(body,receiver,args);};}});
 if(kind==='page')owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],pageAgents:body as any,attempt:async()=>({resolved:false,reason:'unused'})});
 if(kind==='job')owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],agentForJob:body as any,attempt:async()=>({resolved:false,reason:'unused'})});
 if(kind==='enabled')owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],enabled:body as any,attempt:async()=>({resolved:false,reason:'unused'})});
 if(kind==='thread-protection'){state.threadConnections.register({threadId:'protected-fresh',scopeId:'fresh-scope',persistence:'persistent'});state.threadConnections.requestHandoff('protected-fresh');owner=new ThreadConnectionController(state.threadConnections,{protectThreadFromImplicitResume:body} as any);}
 if(kind==='maintenance-completed')owner=new StateMaintenanceScheduler({execute:async()=>({changed:1})} as any,{completed:body});
 try{if(kind==='job')await owner.recoverJob('fresh-job');else if(kind==='thread-protection')owner.start();else await owner.sweep();record('call-getter-'+kind,{calls,lookups,pinned:(owner as any).nonforcingPinned,resource:owner.observeNonforcingExit()});expect(lookups).toBe(0);expect(calls).toBe(1);expect((owner as any).nonforcingPinned).toBe(false);}finally{await owner.close();state.close();}
});
