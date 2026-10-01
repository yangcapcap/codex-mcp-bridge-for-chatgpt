// Retained independent regressions from rejected exact15dc515; only observation sink adapted.
import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}

test.each(['getter','body','pending'])('novel ACK %s remains observable until qualified',async kind=>{
 const {state,jobs}=fixture();let finish!:()=>void,calls=0;const pending=new Promise<void>(r=>finish=r);const u:any=upstream();const original=new Error('ACK unconfirmed');
 if(kind==='getter')Object.defineProperty(u,'acknowledgeExecution',{get(){throw original;}});
 if(kind==='body')u.acknowledgeExecution=()=>{calls++;throw original;};
 if(kind==='pending')u.acknowledgeExecution=()=>{calls++;return pending;};
 jobs.attachUpstream(u);const job=jobs.start(input(),async()=>result);let rejection:any;
 try{try{await job.promise;}catch(e){rejection=e;}jobs.pinNonforcingShutdown();record('ack-'+kind,{status:job.status,calls,rejection:rejection===original,resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().exited).toBe(false);}finally{finish();await pending;await Promise.resolve();state.close();}
});
test('novel throwing change listener is retained instead of quiet EXIT',()=>{
 const {state,jobs}=fixture();const original=new Error('projection listener failed');jobs.subscribeChanges(()=>{throw original;});let error:any;
 try{try{jobs.createAgent({scopeId:randomUUID(),agentName:'retained'});}catch(e){error=e;}jobs.pinNonforcingShutdown();record('listener-throw',{error:error===original,count:state.countAgents(),resource:jobs.observeNonforcingExit(),observations:(jobs as any).nonforcingLateObservationCount});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test.each(['progress','assignment'])('novel invalid %s producer preserves last valid identity',async kind=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let finish!:(v:any)=>void,p:any,a:any;
 const job=jobs.start(input(),async(pp,aa)=>{p=pp;a=aa;a({backendKind:'app-server',workerId:'original-worker',workerGeneration:3,threadId:'original-thread'});return new Promise(r=>finish=r);});await Promise.resolve();await Promise.resolve();const before={version:job.version,workerId:job.workerId,generation:job.workerGeneration,backend:job.backendKind,lastProgress:job.lastProgress};
 try{let error:any;try{if(kind==='progress')p(false);else a(false);}catch(e){error=e;}finish(result);await job.promise;jobs.pinNonforcingShutdown();record('invalid-'+kind,{before,after:{version:job.version,workerId:job.workerId,generation:job.workerGeneration,backend:job.backendKind,lastProgress:job.lastProgress},status:job.status,ack:ack.mock.calls.length,error:String(error),resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(ack).not.toHaveBeenCalled();}finally{state.close();}
});
test.each(['after-pin','getter-pin'])('novel interaction input %s cannot delegate',kind=>{
 const {state,jobs}=fixture();let calls=0;const u:any=upstream();if(true)Object.defineProperty(u,'interactionInput',{get(){if(kind==='getter-pin')jobs.pinNonforcingShutdown();return ()=>{calls++;return undefined;};}});jobs.attachUpstream(u);
 try{if(kind==='after-pin')jobs.pinNonforcingShutdown();let error:any;try{jobs.interactionInput('review-interaction');}catch(e){error=e;}record('interaction-'+kind,{calls,error:String(error),resource:jobs.observeNonforcingExit()});expect(calls).toBe(0);}finally{state.close();}
});
test('novel cancellation rejection message getter pin preserves original terminating job',async()=>{
 const {state,jobs}=fixture();let finish!:(r:any)=>void;let reads=0;const original=new Error();Object.defineProperty(original,'message',{get(){reads++;jobs.pinNonforcingShutdown();return 'late error message';}});
 const u:any=upstream();u.forceTerminateWorker=async()=>{throw original;};jobs.attachUpstream(u);const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:3,upstreamRequestId:'original-request'});return new Promise(r=>finish=r);});await Promise.resolve();await Promise.resolve();
 const intent=jobs.beginCancellationOperation({scopeId:job.scopeId,requestId:randomUUID(),actionHash:'b'.repeat(64),source:'operator',toolName:'review-test',actionName:'cancel-job',target:{kind:'job',jobId:job.jobId,activityId:job.activityId},expectedVersion:job.version,reasonCode:'review-test'}).intent;let statusAtPin:any;
 const initialPin=jobs.pinNonforcingShutdown.bind(jobs);jobs.pinNonforcingShutdown=()=>{statusAtPin={status:job.status,error:job.error,version:job.version};return initialPin();};
 try{let error:any;try{await jobs.cancel(job.jobId,intent);}catch(e){error=e;}record('cancellation-message-getter',{reads,statusAtPin,after:{status:job.status,error:job.error,version:job.version},sqlStatus:state.listJobs()[0].status,error:String(error),resource:jobs.observeNonforcingExit()});expect({status:job.status,error:job.error,version:job.version}).toEqual(statusAtPin);}finally{finish(result);await job.promise;state.close();}
});
test.each(['structured','image','resource','unknown'])('novel SDK-valid %s completion preserves ordinary behavior',async kind=>{
 const {state,jobs}=fixture();const returned:any=kind==='structured'?{structuredContent:{answer:1}}:kind==='image'?{content:[{type:'image',data:'YQ==',mimeType:'image/png'}]}:kind==='resource'?{content:[{type:'resource',resource:{uri:'review:resource',text:'known'}}]}:{content:[],reviewUnknown:{deep:['original']}};
 try{const job=jobs.start(input(),async()=>returned);await job.promise;expect(job.status).toBe('completed');expect(Array.isArray(job.result?.content)).toBe(true);if(kind==='unknown')expect((job.result as any).reviewUnknown).toEqual(returned.reviewUnknown);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test('novel assignment callback poisoned call lookup is never read',async()=>{
 const {state,jobs}=fixture();let reads=0,calls=0;const callback:any=()=>{calls++;};Object.defineProperty(callback,'call',{get(){reads++;jobs.pinNonforcingShutdown();throw Error('must not read');}});
 try{const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'ordinary',workerGeneration:1});return result;},undefined,30,false,callback);await job.promise;expect(calls).toBe(1);expect(reads).toBe(0);expect(job.status).toBe('completed');}finally{state.close();}
});

test('pending ACK resolving after pin cannot upgrade retained uncertainty',async()=>{
 const {state,jobs}=fixture();let finish!:()=>void;const pending=new Promise<void>(r=>finish=r);jobs.attachUpstream(upstream(()=>pending));
 try{const job=jobs.start(input(),async()=>result);await job.promise;const original=(jobs as any).executionAcknowledgements.get(job);expect(original).toBeDefined();jobs.pinNonforcingShutdown();finish();await pending;await Promise.resolve();expect((jobs as any).executionAcknowledgements.get(job)).toBe(original);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{finish();await pending;state.close();}
});
test('ordinary native Promise ACK resolves before pin with original terminal behavior',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn(async()=>{});jobs.attachUpstream(upstream(ack));
 try{const job=jobs.start(input(),async()=>result);await job.promise;await Promise.resolve();expect(ack).toHaveBeenCalledOnce();expect(job.status).toBe('completed');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test.each(['reject','false'])('unsupported ACK %s remains UNKNOWN',async kind=>{
 const {state,jobs}=fixture();const original=new Error('ACK rejection');jobs.attachUpstream(upstream(()=>kind==='reject'?Promise.reject(original):false));
 try{const job=jobs.start(input(),async()=>result);await job.promise;await Promise.resolve();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(job.status).toBe('completed');}finally{state.close();}
});
test('ACK getter pin never invokes its returned delegate',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();const u:any=upstream();Object.defineProperty(u,'acknowledgeExecution',{get(){jobs.pinNonforcingShutdown();return ack;}});jobs.attachUpstream(u);
 try{const job=jobs.start(input(),async()=>result);await job.promise;expect(ack).not.toHaveBeenCalled();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('cancellation accessor error is retained without invoking its message getter',async()=>{
 const {state,jobs}=fixture();let finish!:(r:any)=>void,reads=0;const original=new Error();Object.defineProperty(original,'message',{get(){reads++;jobs.pinNonforcingShutdown();return 'late';}});let before:any;
 const u:any=upstream();u.forceTerminateWorker=async()=>{before={status:job.status,error:job.error,version:job.version};throw original;};jobs.attachUpstream(u);const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original',workerGeneration:2,upstreamRequestId:'original'});return new Promise(r=>finish=r);});await Promise.resolve();await Promise.resolve();
 const intent=jobs.beginCancellationOperation({scopeId:job.scopeId,requestId:randomUUID(),actionHash:'b'.repeat(64),source:'operator',toolName:'review-test',actionName:'cancel-job',target:{kind:'job',jobId:job.jobId,activityId:job.activityId},expectedVersion:job.version,reasonCode:'review-test'}).intent;
 try{let observed:any;try{await jobs.cancel(job.jobId,intent);}catch(e){observed=e;}expect(observed).toBe(original);expect(reads).toBe(0);expect({status:job.status,error:job.error,version:job.version}).toEqual(before);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{finish(result);await job.promise;state.close();}
});
test.each([null,[],{}, {backendKind:'app-server',workerId:'original',workerGeneration:NaN},{backendKind:'app-server',workerId:'original',workerGeneration:1,workerPid:0}])('malformed producer assignment %j retains original identity and outcome',async assignment=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));
 try{const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original',workerGeneration:2});a(assignment as any);return result;});await job.promise;expect(job.workerId).toBe('original');expect(job.workerGeneration).toBe(2);expect(job.status).toBe('running');expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.get(job.jobId).result).toBeDefined();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('explicit retention maintenance rejects after the permanent registry pin',()=>{
 const {state,jobs}=fixture();const before=state.listJobs();try{jobs.pinNonforcingShutdown();expect(()=>jobs.maintainRetainedJobs()).toThrow('NONFORCING_SHUTDOWN_PINNED');expect(state.listJobs()).toEqual(before);}finally{state.close();}
});
test('persistence error snapshots never invoke accessor messages or publish a warning flag after pin',()=>{
 const {state,jobs}=fixture();let reads=0;const original=new Error();Object.defineProperty(original,'message',{get(){reads++;jobs.pinNonforcingShutdown();return 'late';}});try{(jobs as any).recordPersistenceWarning('fixture',original);expect(reads).toBe(0);expect((jobs as any).persistenceWarningShown).toBe(false);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
