import {test,expect,vi,afterEach} from 'vitest';
import {BridgeStateStore} from '../src/stateStore.js';import {ScopeFairQueue} from '../src/scopeFairQueue.js';
import {AutomaticRecoveryController} from '../src/automaticRecovery.js';import {ThreadConnectionController} from '../src/threadConnections.js';import {StateMaintenanceScheduler} from '../src/maintenanceScheduler.js';
// Copied aff9ef7 independent regressions; evidence is the root isolated runner log.
function record(_label:string,_data:unknown):void {}
test.each(['capacity','perScopeCapacity'] as const)('root pinned queue status avoids %s getter and preserves validated limits',field=>{
 let reads=0;const options={capacity:4,perScopeCapacity:2,run() {}};const queue=new ScopeFairQueue(options);queue.enqueue('scope','retained');queue.pinNonforcingShutdown();
 Object.defineProperty(options,field,{get(){reads++;return 100;}});try{expect(queue.status()).toMatchObject({capacity:4,perScopeCapacity:2,queued:1});expect(reads).toBe(0);}finally{queue.close();}
});
test('root pin during an admitted projection retains its original running value and counters',async()=>{
 vi.useFakeTimers();let queue!:ScopeFairQueue<string>;queue=new ScopeFairQueue({capacity:4,perScopeCapacity:2,run(){queue.pinNonforcingShutdown();}});queue.enqueue('scope','in-flight');
 try{await vi.runOnlyPendingTimersAsync();expect(queue.nonforcingHistoryUncertain).toBe(true);expect(queue.status().processed).toBe(0);expect((queue as any).running).toEqual({scopeId:'scope',value:'in-flight'});}finally{queue.close();}
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test.each(['run-pin','getter-pin'])('fresh queue %s cannot start new error callback after pin',async kind=>{
 vi.useFakeTimers();let queue!:ScopeFairQueue<string>;let errors=0,reads=0;const errorBody=()=>{errors++;};
 const options={capacity:4,perScopeCapacity:2,run:()=>{if(kind==='run-pin')queue.pinNonforcingShutdown();throw Error('owned-run-failed');},get onError(){reads++;if(kind==='getter-pin')queue.pinNonforcingShutdown();return errorBody;}};
 queue=new ScopeFairQueue(options);queue.enqueue('scope','admitted');queue.enqueue('scope','retained');
 try{await vi.runOnlyPendingTimersAsync();record('queue-error-'+kind,{errors,reads,status:queue.status(),pinned:(queue as any).nonforcingPinned});expect(errors).toBe(0);expect(queue.status().queued).toBe(1);}finally{queue.close();}
});
test.each(['recovery-changed','thread-changed','maintenance-command','maintenance-defer','maintenance-changed'])('fresh %s invokes intrinsic callback with proper receiver and no call/apply/bind lookup',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let owner:any,options:any,receiver:any,args:any[],lookups=0,calls=0;
 const body=function(this:any,...xs:any[]){receiver=this;args=xs;calls++;return kind==='maintenance-command'?{operation:'maintain',slice:'events'}:kind==='maintenance-defer'?false:undefined;};
 for(const field of ['call','apply','bind'])Object.defineProperty(body,field,{get(){lookups++;owner.pinNonforcingShutdown();throw Error('must-not-look-up');}});
 if(kind==='recovery-changed'){options={candidates:()=>[{key:'fresh',scopeId:'fresh',agentId:'fresh',kind:'recheck'}],attempt:async()=>({resolved:false,reason:'hold'}),changed:body};owner=new AutomaticRecoveryController(state.automaticRecovery,options);}
 if(kind==='thread-changed'){state.threadConnections.register({threadId:'fresh',scopeId:'fresh',persistence:'persistent'});options={changed:body};owner=new ThreadConnectionController(state.threadConnections,{} as any,options);}
 if(kind==='maintenance-command'){options={command:body};owner=new StateMaintenanceScheduler({execute:async()=>({changed:0})} as any,options);}
 if(kind==='maintenance-defer'){options={shouldDefer:body};owner=new StateMaintenanceScheduler({execute:async()=>({changed:0})} as any,options);}
 if(kind==='maintenance-changed'){options={changed:body};owner=new StateMaintenanceScheduler({execute:async()=>({changed:1})} as any,options);}
 try{if(kind==='thread-changed')owner.request('fresh');else await owner.sweep(kind==='maintenance-command'?'events':undefined);record('intrinsic-'+kind,{lookups,calls,args:args!,sameReceiver:receiver===options,pinned:(owner as any).nonforcingPinned});expect(lookups).toBe(0);expect(calls).toBeGreaterThan(0);expect(receiver).toBe(options);if(kind==='maintenance-command')expect(args!).toEqual(['events']);else expect(args!).toEqual([]);}finally{await owner.close();state.close();}
});
test('fresh recovery changed callback pin suppresses later attempt and preserves attempt journal',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;let initial:any;const attempt=vi.fn(async()=>({resolved:true,reason:'done',evidence:'done'}));
 owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[{key:'fresh',scopeId:'fresh',agentId:'fresh',kind:'recheck'}],attempt,changed:()=>{owner.pinNonforcingShutdown();initial=owner.observeNonforcingExit();}});
 try{await owner.sweep();record('changed-pin',{initial,fresh:owner.observeNonforcingExit(),row:state.automaticRecovery.get('fresh')});expect(initial.outcome).toBe('timeout');expect(owner.observeNonforcingExit().exited).toBe(true);expect(attempt).not.toHaveBeenCalled();expect(state.automaticRecovery.get('fresh')).toMatchObject({state:'retrying',attempts:1,reason:'inspection-pending'});}finally{await owner.close();state.close();}
});
test('fresh maintenance completion callback pin preserves id and does not touch result accessor or changed hook',async()=>{
 let owner!:StateMaintenanceScheduler;let id:any;let reads=0;const changed=vi.fn();const result={get changed(){reads++;return 1;}};
 owner=new StateMaintenanceScheduler({execute:async(_cmd:any,meta:any)=>{id=meta.commandId;return result;}} as any,{completed:()=>{owner.pinNonforcingShutdown();},changed});
 await owner.sweep('events');record('maintenance-completion-pin',{reads,id,retained:(owner as any).uncertainCommands.get('events'),resource:owner.observeNonforcingExit()});expect(reads).toBe(0);expect(changed).not.toHaveBeenCalled();expect((owner as any).uncertainCommands.get('events').commandId).toBe(id);expect(owner.observeNonforcingExit().outcome).toBe('uncertain');owner.close();
});
test('fresh maintenance rejection after pin remains unknown with original command',async()=>{
 let fail!:(e:any)=>void;let id:any;const promise=new Promise<any>((_r,reject)=>fail=reject);const owner=new StateMaintenanceScheduler({execute:(_cmd:any,meta:any)=>{id=meta.commandId;return promise;}} as any);
 const work=owner.sweep('history');owner.pinNonforcingShutdown();fail(Error('late-owned-rejection'));await work;expect((owner as any).uncertainCommands.get('history').commandId).toBe(id);expect(owner.observeNonforcingExit().outcome).toBe('uncertain');owner.close();
});
