import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered,u};}








async function recoveryFixture(){const f=fixture();f.jobs.attachUpstream(upstream());const seed=f.jobs.start(input(),async()=>result);f.jobs.pinNonforcingShutdown();await seed.promise;const recovered=new CodexJobRegistry({stateStore:f.state,allowedRoots:[process.cwd()],recoverExecutions:true});const job=recovered.get(seed.jobId)!;return {state:f.state,jobs:recovered,job,sessions:new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]})};}


for(const mode of ['receipt','worker'])test('LOCAL original authority capture helper cannot rebind '+mode+' after async wait',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any,captureCalls=0;const gate=new Promise<void>(r=>go=r);
 u.recoverExecution=async()=>{await gate;if(mode==='receipt')job.executionReceipt=false;else {job.workerId='local-rebound';job.workerGeneration=47;}
  const helper=Reflect.get(jobs,'captureOriginalJobAuthority');if(typeof helper==='function'){captureCalls++;Reflect.apply(helper,jobs,[job]);}return result;
 };
 try{jobs.attachUpstream(u,sessions);go();await job.promise;jobs.pinNonforcingShutdown();record('local-capture-'+mode,{captureCalls,prototypeHasCapture:Object.hasOwn(Object.getPrototypeOf(jobs),'captureOriginalJobAuthority'),sql:state.listJobs()[0],ack:ack.mock.calls.length,resource:jobs.observeNonforcingExit(),originalSettlementRetained:(jobs as any).deferredSettlements.get(job.jobId)?.result===result});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);
 }finally{go();state.close();}
});
test('LOCAL ordinary native async reassignment and progress preserve receipt and correlated threads',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any;const gate=new Promise<void>(r=>go=r);
 u.recoverExecution=async function(this:any,_id:string,p:any,a:any){expect(this).toBe(u);a({backendKind:'app-server',workerId:'first-worker',workerGeneration:1,threadId:'first-thread'});await gate;p({progress:.4,total:1});a({backendKind:'app-server',workerId:'second-worker',workerGeneration:2,threadId:'second-thread',upstreamRequestId:'second-turn'});p({progress:.9,total:1});return result;};
 try{jobs.attachUpstream(u,sessions);go();await job.promise;expect(job.executionReceipt).toBe(true);expect(job.workerId).toBe('second-worker');expect(job.workerGeneration).toBe(2);expect(job.threadId).toBe('second-thread');expect(job.sessionDecision.threadId).toBe('second-thread');expect(state.listJobs()[0].workerId).toBe('second-worker');expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{go();state.close();}
});
test('LOCAL original async native rejection after pin keeps receipt worker and original error',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any;const gate=new Promise<void>(r=>go=r),raw=new Error('original native recovered rejection');
 u.recoverExecution=async (_id:string,_p:any,a:any)=>{a({backendKind:'app-server',workerId:'owned-reject',workerGeneration:3,upstreamRequestId:'owned-turn'});await gate;throw raw;};
 try{jobs.attachUpstream(u,sessions);const before=state.listJobs()[0];jobs.pinNonforcingShutdown();go();await job.promise;expect(job.executionReceipt).toBe(true);expect(job.workerId).toBe('owned-reject');expect(state.listJobs()[0]).toEqual(before);expect((jobs as any).deferredSettlements.get(job.jobId)?.error).toBe(raw);expect(ack).not.toHaveBeenCalled();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{go();state.close();}
});
function cancelIntent(jobs:any,job:any){return jobs.beginCancellationOperation({scopeId:job.scopeId,requestId:randomUUID(),actionHash:'a'.repeat(64),source:'operator',toolName:'local-correctness-test',actionName:'cancel-job',target:{kind:'job',jobId:job.jobId,activityId:job.activityId,turnId:job.upstreamRequestId},expectedVersion:job.version,reasonCode:'test-cancel'}).intent;}
test('LOCAL ordinary recovered completion wins cancellation with exact worker receipt preserved',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any;const gate=new Promise<void>(r=>go=r),assignment={backendKind:'app-server',workerId:'cancel-owned',workerGeneration:4,upstreamRequestId:'cancel-turn',threadId:'cancel-thread'};
 u.recoverExecution=async (_id:string,_p:any,a:any)=>{a(assignment);await gate;return result;};u.forceTerminateWorker=vi.fn(async (a:any)=>{go();await job.promise;return {...a,mode:'already-completed',exited:true,workerExited:false,escalated:false};});
 try{jobs.attachUpstream(u,sessions);await jobs.cancel(job.jobId,cancelIntent(jobs,job));await job.promise;expect(job.status).toBe('completed');expect(job.executionReceipt).toBe(true);expect(job.workerId).toBe('cancel-owned');expect(job.workerGeneration).toBe(4);record('local-cancel-normal',{ackCalls:ack.mock.calls.map(c=>c[0]),originalId:job.jobId,worker:job.workerId,generation:job.workerGeneration,receipt:job.executionReceipt,status:job.status});expect(ack.mock.calls.length).toBeGreaterThanOrEqual(1);expect(ack.mock.calls.every(c=>c[0]===job.jobId)).toBe(true);expect(u.forceTerminateWorker).toHaveBeenCalledOnce();expect(u.forceTerminateWorker.mock.calls[0][0]).toMatchObject({workerId:'cancel-owned',workerGeneration:4,upstreamRequestId:'cancel-turn'});jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{go();state.close();}
});
test('LOCAL ordinary recovered terminal SQL retry preserves original producer worker and receipt',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any,attempts=0,done=false;const gate=new Promise<void>(r=>go=r),upsert=state.upsertJob.bind(state);state.upsertJob=((j:any)=>{if(j.status==='completed'&&attempts++===0)throw Error('local one-time terminal contention');return upsert(j);}) as any;
 u.recoverExecution=async (_id:string,p:any,a:any)=>{a({backendKind:'app-server',workerId:'retry-owned',workerGeneration:5,threadId:'retry-thread'});await gate;p({progress:.7,total:1});return result;};
 try{jobs.attachUpstream(u,sessions);const owned=job.promise;void owned.then(()=>{done=true;});go();for(let i=0;i<20;i++)await Promise.resolve();expect(done).toBe(false);expect(job.status).toBe('running');expect(job.executionReceipt).toBe(true);expect(job.workerId).toBe('retry-owned');await owned;expect(attempts).toBeGreaterThanOrEqual(2);expect(state.listJobs()[0].status).toBe('completed');expect(job.workerId).toBe('retry-owned');expect(job.executionReceipt).toBe(true);expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{go();state.close();}
});
