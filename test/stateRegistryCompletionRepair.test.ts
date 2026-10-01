// Original f122428 independent regressions; observation sink only adapted.
import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}

test('fresh ACK native Promise species lookup cannot delegate after its constructor getter pins',async()=>{
 const {state,jobs}=fixture();let release!:()=>void,lookups=0,species=0;const p=new Promise<void>(r=>release=r);
 Object.defineProperty(p,'constructor',{get(){lookups++;jobs.pinNonforcingShutdown();return {[Symbol.species]:class extends Promise<any>{constructor(executor:any){species++;super(executor);}}};}});
 jobs.attachUpstream(upstream(()=>p));
 try{const job=jobs.start(input(),async()=>result);await job.promise;record('ack-species-pin',{lookups,species,status:job.status,resource:jobs.observeNonforcingExit(),retained:(jobs as any).executionAcknowledgements.get(job)?.value===p});expect(species).toBe(0);}finally{release();await Promise.resolve();state.close();}
});
test.each(['wrong-string','object','empty'])('fresh assignment malformed persistence %s retains original worker observation',async kind=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));const raw:any={backendKind:'app-server',workerId:'new-worker',workerGeneration:9,threadPersistence:kind==='wrong-string'?'invalid':kind==='object'?{unknown:true}:''};
 const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1,threadPersistence:'ephemeral'});a(raw);return result;});
 try{await job.promise;jobs.pinNonforcingShutdown();record('assignment-persistence-'+kind,{worker:job.workerId,generation:job.workerGeneration,persistence:job.threadPersistence,status:job.status,ack:ack.mock.calls.length,resource:jobs.observeNonforcingExit()});expect(job.workerId).toBe('original-worker');expect(job.status).toBe('running');expect(ack).not.toHaveBeenCalled();}finally{state.close();}
});
test.each(['false','promise'])('fresh completion undo %s return remains unconfirmed',async kind=>{
 const {state,jobs}=fixture();const original=state.upsertJob.bind(state);let rejected=false,undoCalls=0,release!:()=>void;const p=new Promise<void>(r=>release=r);
 state.upsertJob=((job:any)=>{if(!rejected&&job.status==='completed'){rejected=true;throw new Error('fixture terminal projection conflict');}return original(job);}) as any;
 const job=jobs.start(input(),async()=>result,()=>()=>{undoCalls++;return (kind==='false'?false:p) as any;});
 try{await job.promise;jobs.pinNonforcingShutdown();record('undo-'+kind,{undoCalls,status:job.status,resource:jobs.observeNonforcingExit(),observations:(jobs as any).nonforcingLateObservationCount,deferred:(jobs as any).deferredSettlements.has(job.jobId)});expect(undoCalls).toBe(1);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{release();await p;state.close();}
});
test('fresh completion callback exception preserves original successful producer outcome uncertainty',async()=>{
 const {state,jobs}=fixture();const original=new Error('completion projection rejected');const job=jobs.start(input(),async()=>result,()=>{throw original;});
 try{await job.promise;jobs.pinNonforcingShutdown();record('completion-exception',{status:job.status,resource:jobs.observeNonforcingExit(),observations:(jobs as any).nonforcingLateObservationCount,deferred:(jobs as any).deferredSettlements.has(job.jobId)});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test.each(['resolve','reject'])('fresh ACK pending %s after pin retains exact identity and permanent uncertainty',async kind=>{
 const {state,jobs}=fixture();let resolve!:()=>void,reject!:(e:unknown)=>void;const p=new Promise<void>((r,j)=>{resolve=r;reject=j;});const error=new Error('original late ACK');jobs.attachUpstream(upstream(()=>p));
 try{const job=jobs.start(input(),async()=>result);await job.promise;const original=(jobs as any).executionAcknowledgements.get(job);expect(original?.value).toBe(p);jobs.pinNonforcingShutdown();if(kind==='resolve')resolve();else reject(error);await Promise.resolve();await Promise.resolve();expect((jobs as any).executionAcknowledgements.get(job)).toBe(original);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');if(kind==='reject')expect([...(jobs as any).nonforcingLateObservations.get(job.jobId)]).toContainEqual({kind:'execution-ack-error',value:error});}finally{resolve();await Promise.resolve();state.close();}
});
test('fresh ACK thenable is retained without reading then getter',async()=>{
 const {state,jobs}=fixture();let reads=0;const p={get then(){reads++;return ()=>{};}};jobs.attachUpstream(upstream(()=>p));
 try{const job=jobs.start(input(),async()=>result);await job.promise;jobs.pinNonforcingShutdown();expect(reads).toBe(0);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect((jobs as any).executionAcknowledgements.get(job)?.value).toBe(p);}finally{state.close();}
});
test('fresh captured ACK callback uses original receiver and never poisoned .call',async()=>{
 const {state,jobs}=fixture();let reads=0,called=0;const u:any=upstream();const callback:any=function(this:any){expect(this).toBe(u);called++;};Object.defineProperty(callback,'call',{get(){reads++;jobs.pinNonforcingShutdown();throw Error('poisoned');}});u.acknowledgeExecution=callback;jobs.attachUpstream(u);
 try{const job=jobs.start(input(),async()=>result);await job.promise;expect(called).toBe(1);expect(reads).toBe(0);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test('fresh interaction callback body pin rejects original data before accessor inspection',()=>{
 const {state,jobs}=fixture();let calls=0,reads=0;const u:any=upstream();u.interactionInput=function(this:any){expect(this).toBe(u);calls++;jobs.pinNonforcingShutdown();return {get hidden(){reads++;throw Error('no read');}};};jobs.attachUpstream(u);
 try{expect(()=>jobs.interactionInput('original')).toThrow('NONFORCING_SHUTDOWN_PINNED');expect(calls).toBe(1);expect(reads).toBe(0);}finally{state.close();}
});
test('fresh interaction result accessor rejects without invocation or promotion',()=>{
 const {state,jobs}=fixture();let reads=0;const u:any=upstream();u.interactionInput=()=>({get hidden(){reads++;throw Error('no read');}});jobs.attachUpstream(u);
 try{expect(()=>jobs.interactionInput('original')).toThrow('STATE_CALLBACK_DATA_UNCONFIRMED');expect(reads).toBe(0);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('fresh terminal callback data getter pin cannot mutate or delegate late progress',async()=>{
 const {state,jobs}=fixture();let finish!:(v:any)=>void,p:any;const job=jobs.start(input(),async(pp)=>{p=pp;return new Promise(r=>finish=r);});await Promise.resolve();await Promise.resolve();const before={status:job.status,version:job.version};const proxy=new Proxy({progress:8},{getOwnPropertyDescriptor(t,k){jobs.pinNonforcingShutdown();return Reflect.getOwnPropertyDescriptor(t,k);}});
 try{p(proxy);finish(result);await job.promise;expect({status:job.status,version:job.version}).toEqual(before);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('ACK constructor accessor is rejected without any getter or species delegation',async()=>{
 const {state,jobs}=fixture();let finish!:()=>void,reads=0,calls=0;const pending=new Promise<void>(r=>finish=r);Object.defineProperty(pending,'constructor',{get(){reads++;jobs.pinNonforcingShutdown();return {[Symbol.species]:class extends Promise<any>{constructor(executor:any){calls++;super(executor);}}};}});jobs.attachUpstream(upstream(()=>pending));
 try{const job=jobs.start(input(),async()=>result);await job.promise;expect(reads).toBe(0);expect(calls).toBe(0);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect((jobs as any).executionAcknowledgements.get(job)?.value).toBe(pending);}finally{finish();await Promise.resolve();state.close();}
});
test('throwing undo preserves both original successful outcome and undo exception',async()=>{
 const {state,jobs}=fixture();const upsert=state.upsertJob.bind(state);let conflict=false;const original=new Error('undo original');state.upsertJob=((job:any)=>{if(!conflict && job.status==='completed'){conflict=true;throw Error('terminal conflict');}return upsert(job);}) as any;
 try{const job=jobs.start(input(),async()=>result,()=>()=>{throw original;});await job.promise;expect(job.status).toBe('running');expect((jobs as any).deferredSettlements.get(job.jobId).kind).toBe('resolved');expect((jobs as any).nonforcingLateObservations.get(job.jobId)).toContainEqual({kind:'terminal-undo-error',value:original});jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('synchronous undefined undo retains ordinary rollback and failure semantics',async()=>{
 const {state,jobs}=fixture();const upsert=state.upsertJob.bind(state);let conflict=false;const undo=vi.fn(()=>undefined);state.upsertJob=((job:any)=>{if(!conflict && job.status==='completed'){conflict=true;throw Error('terminal conflict');}return upsert(job);}) as any;
 try{const job=jobs.start(input(),async()=>result,()=>undo);await job.promise;expect(undo).toHaveBeenCalledOnce();expect(job.status).toBe('failed');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test.each([false,{codex:3},{codex:'fixture',requestedAuthMode:'invalid'},{codex:'fixture',python:false}])('malformed runtime assignment %j retains original worker and producer result',async runtime=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));try{const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});a({backendKind:'app-server',workerId:'new',workerGeneration:2,runtime} as any);return result;});await job.promise;expect(job.workerId).toBe('original-worker');expect(job.status).toBe('running');expect(ack).not.toHaveBeenCalled();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
