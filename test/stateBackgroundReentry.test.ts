import {test,expect,vi,afterEach} from 'vitest';
import {BridgeStateStore} from '../src/stateStore.js';
import {AutomaticRecoveryController,automaticRecoveryKey} from '../src/automaticRecovery.js';
import {ThreadConnectionController} from '../src/threadConnections.js';
import {StateMaintenanceScheduler} from '../src/maintenanceScheduler.js';
import {ScopeFairQueue} from '../src/scopeFairQueue.js';
// Retained abb21de independent regressions, copied as implementation baselines.
function record(_label:string,_data:unknown):void {}
const candidate={key:automaticRecoveryKey('recheck',['reviewer',1]),scopeId:'scope-reviewer',agentId:'agent-reviewer',kind:'recheck' as const};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test.each(['result-getter','clock-callback'])('reviewer recovery %s pin must retain pending journal without publishing confirmation',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:AutomaticRecoveryController;let dispatched=false,before:any;
 const pin=()=>{before??=state.automaticRecovery.get(candidate.key);owner.pinNonforcingShutdown();};
 const result={get resolved(){if(kind==='result-getter')pin();return true;},reason:'reviewer-confirmed',evidence:'reviewer-observed'};
 owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[candidate],attempt:async()=>{dispatched=true;return result;},now:()=>{if(kind==='clock-callback'&&dispatched)pin();return 1000;}});
 try{await owner.sweep();const row=state.automaticRecovery.get(candidate.key);record('recovery-'+kind,{before,after:row,resource:owner.observeNonforcingExit()});expect(row).toMatchObject({state:'retrying',attempts:1,reason:'inspection-pending'});expect(row?.evidence).toBeUndefined();}finally{await owner.close();state.close();}
});
test.each(['result-getter','clock-callback'])('reviewer thread %s pin must retain releasing row without publishing release evidence',async kind=>{
 const state=new BridgeStateStore({file:':memory:'});let owner!:ThreadConnectionController;let released=false,before:any;
 state.threadConnections.register({threadId:'review-owned-thread',scopeId:'scope-reviewer',persistence:'persistent'});state.threadConnections.requestHandoff('review-owned-thread');
 const pin=()=>{before??=state.threadConnections.get('review-owned-thread');owner.pinNonforcingShutdown();};
 const result={get phase(){if(kind==='result-getter')pin();return 'released' as const;},evidence:'worker-exited' as const};
 owner=new ThreadConnectionController(state.threadConnections,{releaseThreadConnection:async()=>{released=true;return result;}} as any,{now:()=>{if(kind==='clock-callback'&&released)pin();return 1000;}});
 try{await owner.sweep();const row=state.threadConnections.get('review-owned-thread');record('thread-'+kind,{before,after:row,resource:owner.observeNonforcingExit()});expect(row).toMatchObject({phase:'releasing',handoffRequested:true});expect(row?.evidence).toBeUndefined();}finally{await owner.close();state.close();}
});
test.each(['thread','recovery','maintenance'])('reviewer %s start must not install a timer after its interval getter pins',async kind=>{
 vi.useFakeTimers();const state=new BridgeStateStore({file:':memory:'});let owner:any;let observed:any;
 const options={get intervalMs(){owner.pinNonforcingShutdown();observed=owner.observeNonforcingExit();return 5000;}};
 if(kind==='thread')owner=new ThreadConnectionController(state.threadConnections,{} as any,options);
 if(kind==='recovery')owner=new AutomaticRecoveryController(state.automaticRecovery,{...Object.getOwnPropertyDescriptors({}),candidates:()=>[],attempt:async()=>({resolved:false,reason:'unused'}),get intervalMs(){return options.intervalMs;}});
 if(kind==='maintenance')owner=new StateMaintenanceScheduler({execute:vi.fn()} as any,options);
 try{owner.start();record('interval-start-'+kind,{duringPin:observed,afterStart:owner.observeNonforcingExit(),timerPresent:Boolean(owner.timer),timerCount:vi.getTimerCount()});expect(observed.exited).toBe(true);expect(owner.timer).toBeUndefined();expect(vi.getTimerCount()).toBe(0);}finally{clearInterval(owner.timer);await owner.close();state.close();}
});
test.each(['capacity','perScopeCapacity'])('reviewer queue %s getter pin cannot admit a new retained snapshot',field=>{
 vi.useFakeTimers();let queue!:ScopeFairQueue<string>,armed=false;
 const options={get capacity(){if(field==='capacity'&&armed){armed=false;queue.pinNonforcingShutdown();}return 4;},get perScopeCapacity(){if(field==='perScopeCapacity'&&armed){armed=false;queue.pinNonforcingShutdown();}return 2;},run:vi.fn()};
 queue=new ScopeFairQueue(options);queue.enqueue('first','previous');const original=queue.status();armed=true;
 const accepted=queue.enqueue('second','late');record('queue-'+field,{accepted,before:original,after:queue.status()});expect(accepted).toBe(false);expect(queue.status()).toEqual(original);queue.close();
});
test('reviewer genuine pending recovery quiescence never rewrites unresolved durable journal',async()=>{
 const state=new BridgeStateStore({file:':memory:'});let resolve!:(r:any)=>void;const pending=new Promise<any>(r=>resolve=r);let started!:()=>void;const admitted=new Promise<void>(r=>started=r);
 const owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[candidate],attempt:()=>{started();return pending;},now:()=>1000});
 try{const work=owner.sweep();await admitted;const original=state.automaticRecovery.get(candidate.key);owner.pinNonforcingShutdown();const before=owner.observeNonforcingExit();expect(before.outcome).toBe('timeout');resolve({resolved:true,reason:'late',evidence:'late'});await work;expect(owner.observeNonforcingExit().exited).toBe(true);expect(before.outcome).toBe('timeout');expect(state.automaticRecovery.get(candidate.key)).toEqual(original);}finally{await owner.close();state.close();}
});
