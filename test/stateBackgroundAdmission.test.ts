import {test,expect,vi,afterEach} from 'vitest';
import {BridgeStateStore} from '../src/stateStore.js';
import {ThreadConnectionController} from '../src/threadConnections.js';
import {AutomaticRecoveryController,automaticRecoveryKey} from '../src/automaticRecovery.js';
import {StateMaintenanceScheduler} from '../src/maintenanceScheduler.js';
// Copied b3fc3fd review baselines; a single captured method intentionally avoids the second getter.
function record(_label:string,_data:unknown):void {}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test.each(['request','cancel'] as const)('novel thread %s clock reentry cannot mutate handoff after pin',async method=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:ThreadConnectionController;let before:any;
 state.threadConnections.register({threadId:'novel-thread',scopeId:'scope-novel',persistence:'persistent'});
 if(method==='cancel')state.threadConnections.requestHandoff('novel-thread',100);
 owner=new ThreadConnectionController(state.threadConnections,{} as any,{now:()=>{before=state.threadConnections.get('novel-thread');owner.pinNonforcingShutdown();return 1234;}});
 try{let error:any;try{owner[method]('novel-thread');}catch(e){error=e;}
 const after=state.threadConnections.get('novel-thread');record('thread-clock-'+method,{before,after,resource:owner.observeNonforcingExit(),error:String(error)});
 expect(after).toEqual(before);expect(error?.message).toBe('NONFORCING_SHUTDOWN_PINNED');
 }finally{await owner.close();state.close();}
});
test('novel recovery page getter cannot delegate callback after pin',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;let reads=0;
 const page=vi.fn(()=>[]);owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],attempt:async()=>({resolved:false,reason:'unused'}),get pageAgents(){if(++reads===2)owner.pinNonforcingShutdown();return page;}});
 try{await owner.sweep();record('recovery-page-getter',{reads,calls:page.mock.calls.length,resource:owner.observeNonforcingExit()});expect(reads).toBe(1);expect(owner.observeNonforcingExit().outcome).toBe('uncertain');}finally{await owner.close();state.close();}
});
test('novel recovery job resolver getter cannot delegate callback after pin',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;const resolve=vi.fn(()=>undefined);
 owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],attempt:async()=>({resolved:false,reason:'unused'}),get agentForJob(){owner.pinNonforcingShutdown();return resolve;}});
 try{await owner.recoverJob('novel-job');record('recovery-job-getter',{calls:resolve.mock.calls.length,resource:owner.observeNonforcingExit()});expect(resolve).not.toHaveBeenCalled();}finally{await owner.close();state.close();}
});
test.each(['thread','recovery'] as const)('novel %s malformed own receipt preserves journal and sticky unknown',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let owner:any;let reads=0;
 const key=automaticRecoveryKey('recheck',['novel',1]);
 if(kind==='thread'){
 state.threadConnections.register({threadId:'novel-thread',scopeId:'novel',persistence:'persistent'});state.threadConnections.requestHandoff('novel-thread');
 owner=new ThreadConnectionController(state.threadConnections,{releaseThreadConnection:async()=>({phase:'released',get evidence(){reads++;return 'worker-exited';}})} as any,{now:()=>1000});
 }else owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[{key,scopeId:'novel',agentId:'novel',kind:'recheck'}],attempt:async()=>({resolved:true,get reason(){reads++;return 'success';}}),now:()=>1000});
 try{await owner.sweep();owner.pinNonforcingShutdown();const row=kind==='thread'?state.threadConnections.get('novel-thread'):state.automaticRecovery.get(key);
 record('malformed-own-'+kind,{reads,row,resource:owner.observeNonforcingExit()});expect(reads).toBe(0);expect(owner.observeNonforcingExit().outcome).toBe('uncertain');expect(row?.evidence).toBeUndefined();expect(kind==='thread'?row?.phase:row?.state).toBe(kind==='thread'?'releasing':'retrying');
 }finally{await owner.close();state.close();}
});
test.each(['thread','recovery'] as const)('novel %s receipt descriptor trap pin preserves original journal',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let owner:any;let retained:any;const key=automaticRecoveryKey('recheck',['novel',2]);
 const plain=kind==='thread'?{phase:'released',evidence:'worker-exited'}:{resolved:true,reason:'success',evidence:'observed'};
 const result=new Proxy(plain,{ownKeys(target){retained=kind==='thread'?state.threadConnections.get('novel-thread'):state.automaticRecovery.get(key);owner.pinNonforcingShutdown();return Reflect.ownKeys(target);}});
 if(kind==='thread'){state.threadConnections.register({threadId:'novel-thread',scopeId:'novel',persistence:'persistent'});state.threadConnections.requestHandoff('novel-thread');owner=new ThreadConnectionController(state.threadConnections,{releaseThreadConnection:async()=>result} as any,{now:()=>1000});}
 else owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[{key,scopeId:'novel',agentId:'novel',kind:'recheck'}],attempt:async()=>result as any,now:()=>1000});
 try{const work=owner.sweep();await work;const row=kind==='thread'?state.threadConnections.get('novel-thread'):state.automaticRecovery.get(key);record('proxy-pin-'+kind,{retained,row,resource:owner.observeNonforcingExit()});expect(row).toEqual(retained);expect(owner.observeNonforcingExit().exited).toBe(true);}finally{await owner.close();state.close();}
});
test.each(['thread','recovery'] as const)('novel ordinary %s close then pin remains unknown',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});const owner=kind==='thread'?new ThreadConnectionController(state.threadConnections,{} as any):new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],attempt:async()=>({resolved:false,reason:'unused'})});
 try{await owner.close();owner.pinNonforcingShutdown();expect(owner.observeNonforcingExit().outcome).toBe('uncertain');await owner.sweep();expect(owner.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('novel maintenance late result retains exact original command id',async()=>{
 let finish!:(r:any)=>void;const pending=new Promise<any>(r=>finish=r);let commandId:string|undefined;
 const owner=new StateMaintenanceScheduler({execute:(_cmd:any,meta:any)=>{commandId=meta.commandId;return pending;}} as any);
 const work=owner.sweep('events');const originalId=commandId;owner.pinNonforcingShutdown();const initial=owner.observeNonforcingExit();finish({changed:3});await work;
 const retained=(owner as any).uncertainCommands.get('events');record('maintenance-late',{originalId,retained,initial,fresh:owner.observeNonforcingExit()});expect(retained.commandId).toBe(originalId);expect(initial.outcome).toBe('uncertain');expect(owner.observeNonforcingExit().outcome).toBe('uncertain');owner.close();
});
test('novel recovery candidate own getter cannot create durable attempt after pin',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;let before:any,reads=0;const key=automaticRecoveryKey('recheck',['novel-candidate',1]);
 const candidate={key,agentId:'novel',kind:'recheck' as const,get scopeId(){reads++;before=state.automaticRecovery.get(key);owner.pinNonforcingShutdown();return 'novel';}};
 const attempt=vi.fn(async()=>({resolved:true,reason:'success',evidence:'observed'}));
 owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[candidate],attempt,now:()=>1000});
 try{await owner.sweep();const row=state.automaticRecovery.get(key);record('candidate-getter',{reads,before:before??null,row,attempts:attempt.mock.calls.length,resource:owner.observeNonforcingExit()});expect(row).toEqual(before);expect(attempt).not.toHaveBeenCalled();}finally{await owner.close();state.close();}
});

test('root page callback pin suppresses cursor reset and a second page invocation',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;const page=vi.fn(()=>{owner.pinNonforcingShutdown();return [];});
 owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],pageAgents:page,attempt:async()=>({resolved:false,reason:'unused'})});(owner as any).agentCursor='retained-cursor';
 try{await owner.sweep();expect(page).toHaveBeenCalledTimes(1);expect((owner as any).agentCursor).toBe('retained-cursor');}finally{await owner.close();state.close();}
});
test('root initial page getter pin invokes no returned page callback',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;const page=vi.fn(()=>[]);
 owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],get pageAgents(){owner.pinNonforcingShutdown();return page;},attempt:async()=>({resolved:false,reason:'unused'})});
 try{await owner.sweep();expect(page).not.toHaveBeenCalled();}finally{await owner.close();state.close();}
});

test.each(['slot','field'] as const)('root recovery %s accessor is rejected without invoking it',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let reads=0;
 const candidate:any={key:'own-candidate',scopeId:'scope',agentId:'agent',kind:'recheck'};
 const candidates:any[]=[candidate];
 if(kind==='field')Object.defineProperty(candidate,'scopeId',{get(){reads++;return 'scope';}});
 else Object.defineProperty(candidates,'0',{get(){reads++;return candidate;}});
 const attempt=vi.fn(async()=>({resolved:true,reason:'success'}));
 const owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>candidates,attempt});
 try{await owner.sweep();owner.pinNonforcingShutdown();expect(reads).toBe(0);expect(attempt).not.toHaveBeenCalled();expect(state.automaticRecovery.list()).toEqual([]);expect(owner.observeNonforcingExit().outcome).toBe('uncertain');}finally{await owner.close();state.close();}
});
test('root candidate descriptor pin stops subsequent descriptor traps and journal admission',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;const fields:string[]=[];
 const candidate=new Proxy({key:'proxy-candidate',scopeId:'scope',agentId:'agent',kind:'recheck' as const},{getOwnPropertyDescriptor(target,key){fields.push(String(key));owner.pinNonforcingShutdown();return Reflect.getOwnPropertyDescriptor(target,key);}});
 const attempt=vi.fn(async()=>({resolved:true,reason:'success'}));owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[candidate],attempt});
 try{await owner.sweep();expect(fields).toEqual(['key']);expect(attempt).not.toHaveBeenCalled();expect(state.automaticRecovery.list()).toEqual([]);}finally{await owner.close();state.close();}
});
test('root page slot accessor never invokes a hidden callback or alters cursor',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let reads=0;const page=['agent'];Object.defineProperty(page,'0',{get(){reads++;return 'agent';}});
 const owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],pageAgents:()=>page,attempt:async()=>({resolved:false,reason:'unused'})});(owner as any).agentCursor='retained';
 try{await owner.sweep();owner.pinNonforcingShutdown();expect(reads).toBe(0);expect((owner as any).agentCursor).toBe('retained');expect(owner.observeNonforcingExit().outcome).toBe('uncertain');}finally{await owner.close();state.close();}
});
