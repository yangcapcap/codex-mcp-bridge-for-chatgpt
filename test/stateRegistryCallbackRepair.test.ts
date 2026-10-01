// Retained reviewer regressions from exact3220b2a, plus owner/control cases.
// The deferred case deliberately does not await its retained unlaunched promise.
import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown) {}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
test.each(['false','promise'])('fresh nonvoid assignment callback %s cannot certify registry quiet',async kind=>{
 const {state,jobs}=fixture();let release!:()=>void;const pending=new Promise<void>(r=>release=r);const ack=vi.fn();jobs.attachUpstream(upstream(ack));const value=kind==='false'?false:pending;
 const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'worker-review',workerGeneration:1,upstreamRequestId:'request-review',threadId:'review-thread'});return result;},undefined,30,false,(()=>value) as any);
 try{await job.promise;jobs.pinNonforcingShutdown();record('assignment-return-'+kind,{status:job.status,ack:ack.mock.calls.length,resource:jobs.observeNonforcingExit(),observations:(jobs as any).nonforcingLateObservationCount});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{release();await pending;state.close();}
});
test('fresh deferred activation auth callback pin retains original deferred identity',async()=>{
 let armed=false;let jobs!:CodexJobRegistry;const f=fixture({authBoundary:()=>{if(armed)jobs.pinNonforcingShutdown();return 'owner-original';}});jobs=f.jobs;const run=vi.fn(async()=>result);const job=jobs.start(input(),run,undefined,30,false,undefined,true);const original=(jobs as any).deferredExecutions.get(job.jobId);
 try{armed=true;let thrown:any;try{jobs.activateDeferredExecution(job.jobId);}catch(e){thrown=e;}await Promise.resolve();record('deferred-auth-pin',{retained:(jobs as any).deferredExecutions.has(job.jobId),runCalls:run.mock.calls.length,status:job.status,error:String(thrown),resource:jobs.observeNonforcingExit()});expect((jobs as any).deferredExecutions.get(job.jobId)).toBe(original);expect(run).not.toHaveBeenCalled();}finally{f.state.close();}
});
test('fresh retained ownership getter cannot delegate its returned callback after pin',async()=>{
 let boundary='owner-original';const {state,jobs}=fixture({authBoundary:()=>boundary});let calls=0,reads=0;const u:any=upstream();Object.defineProperty(u,'ownsRetainedResult',{get(){reads++;jobs.pinNonforcingShutdown();return ()=>{calls++;return true;};}});jobs.attachUpstream(u);
 const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'worker-review',workerGeneration:1,upstreamRequestId:'request-review',threadId:'review-thread'});boundary='owner-changed';return result;});
 try{await job.promise;record('owns-retained-getter',{reads,calls,status:job.status,resource:jobs.observeNonforcingExit()});expect(calls).toBe(0);}finally{state.close();}
});
test.each([false,{content:[false]}])('fresh malformed result %s is not terminal receipt authority',async returned=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));const job=jobs.start(input(),async()=>returned as any);
 try{await job.promise;jobs.pinNonforcingShutdown();record('malformed-result-'+String(returned),{status:job.status,ack:ack.mock.calls.length,sql:state.listJobs()[0].status,resource:jobs.observeNonforcingExit()});expect(job.status).toBe('running');expect(ack).not.toHaveBeenCalled();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test.each(['result','assignment','progress'])('fresh %s ownKeys pin retains original job and outcome',async kind=>{
 const {state,jobs}=fixture();let finish!:(r:any)=>void,p:any,a:any;const job=jobs.start(input(),async(pp,aa)=>{p=pp;a=aa;return new Promise(r=>finish=r);});await Promise.resolve();await Promise.resolve();const before={status:job.status,version:job.version,workerId:job.workerId};
 const data:any=kind==='result'?result:kind==='assignment'?{backendKind:'app-server',workerId:'new',workerGeneration:1}:{progress:7,message:'new'};let traps=0;const proxy=new Proxy(data,{ownKeys(t){traps++;jobs.pinNonforcingShutdown();return Reflect.ownKeys(t);}});
 try{if(kind==='assignment')a(proxy);else if(kind==='progress')p(proxy);finish(kind==='result'?proxy:result);await job.promise;record('proxy-'+kind,{traps,before,after:{status:job.status,version:job.version,workerId:job.workerId},resource:jobs.observeNonforcingExit()});expect({status:job.status,version:job.version,workerId:job.workerId}).toEqual(before);expect((jobs as any).deferredSettlements.has(job.jobId)).toBe(true);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('fresh data snapshot keeps alias values independently and safely captures __proto__ own data',()=>{
 const child={value:'retained'};const raw:any={a:child,b:child};Object.defineProperty(raw,'__proto__',{value:{polluted:true},enumerable:true});const captured=snapshotNonforcingData(raw,()=>false);expect(captured.ok).toBe(true);if(captured.ok){expect(captured.value.a).toEqual(child);expect(captured.value.a).not.toBe(child);expect(captured.value.a).not.toBe(captured.value.b);expect(Object.hasOwn(captured.value,'__proto__')).toBe(true);expect(Object.getPrototypeOf(captured.value)).toBe(Object.prototype);}
});
test.each(['cycle','sparse','inherited','getter'])('fresh data snapshot %s inspection is bounded and never invokes accessor',kind=>{
 let reads=0;let value:any;if(kind==='cycle'){value={};value.self=value;}if(kind==='sparse')value=new Array(1);if(kind==='inherited')value=Object.create({get hidden(){reads++;return true;}});if(kind==='getter'){value={};Object.defineProperty(value,'hidden',{get(){reads++;return true;}});}
 const captured=snapshotNonforcingData(value,()=>false);if(kind==='inherited')expect(captured).toEqual({ok:true,value:{}});else expect(captured.ok).toBe(false);expect(reads).toBe(0);
});

test('active ownership getter pin cannot delegate a captured control callback',async()=>{
 let boundary='owner-original';const {state,jobs}=fixture({authBoundary:()=>boundary});let calls=0,finish!:(r:any)=>void;const u:any=upstream();
 Object.defineProperty(u,'ownsActiveExecution',{get(){jobs.pinNonforcingShutdown();return ()=>{calls++;return true;};}});jobs.attachUpstream(u);
 const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'worker-review',workerGeneration:1,upstreamRequestId:'request-review',threadId:'review-thread'});return new Promise(r=>{finish=r;});});await Promise.resolve();await Promise.resolve();
 try{boundary='changed';await expect(jobs.cancel(job.jobId,{} as any)).rejects.toThrow('NONFORCING_SHUTDOWN_PINNED');expect(calls).toBe(0);finish(result);await job.promise;expect(job.status).toBe('running');}finally{state.close();}
});
test('assignment callback exception retains original owner outcome without a fabricated failure ACK',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));const original=new Error('assignment projection unconfirmed');
 const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'worker-review',workerGeneration:1,upstreamRequestId:'request-review',threadId:'review-thread'});return result;},undefined,30,false,()=>{throw original;});
 try{await job.promise;expect(job.status).toBe('running');expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.get(job.jobId).kind).toBe('resolved');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('SDK v2 structured-only result default and valid resource content retain ordinary completion',async()=>{
 const {state,jobs}=fixture();try {for(const returned of [{structuredContent:{threadId:'ordinary'}},{content:[{type:'resource_link',name:'retained',uri:'https://example.invalid/retained'}]}]) {
  const job=jobs.start(input(),async()=>returned as any);await job.promise;expect(job.status).toBe('completed');expect(Array.isArray(job.result?.content)).toBe(true);
 }} finally {state.close();}
});
