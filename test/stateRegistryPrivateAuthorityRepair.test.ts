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


for(const mode of ['async-receipt','async-worker','late-progress-receipt','late-assignment-worker'])test('NEW async recovery authority '+mode+' remains original and unconfirmed',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any,onProgress:any,onAssigned:any;const gate=new Promise<void>(r=>go=r);
 u.recoverExecution=async function(this:any,_id:string,p:any,a:any){expect(this).toBe(u);onProgress=p;onAssigned=a;await gate;
  if(mode.includes('receipt'))job.executionReceipt=false;else {job.workerId='foreign-late';job.workerGeneration=73;}
  if(mode==='late-progress-receipt')onProgress({progress:.5,total:1});
  if(mode==='late-assignment-worker')onAssigned({backendKind:'app-server',workerId:'foreign-late',workerGeneration:73,upstreamRequestId:'foreign-turn'});
  return result;
 };
 try{jobs.attachUpstream(u,sessions);const owned=job.promise;go();await owned;for(let i=0;i<4;i++)await Promise.resolve();jobs.pinNonforcingShutdown();record(mode,{liveReceipt:job.executionReceipt,worker:job.workerId,sql:state.listJobs()[0],ack:ack.mock.calls.length,resource:jobs.observeNonforcingExit(),deferredOriginal:(jobs as any).deferredSettlements.get(job.jobId)?.result===result});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(ack).not.toHaveBeenCalled();expect(state.listJobs()[0].executionReceipt).toBe(true);expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);
 }finally{go();for(let i=0;i<20;i++)await Promise.resolve();state.close();}
});
for(const kind of ['progress','assignment'])test('NEW recovery '+kind+' descriptor trap cannot silently refresh changed authority',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let traps=0;const plain:any=kind==='progress'?{progress:.5,total:1}:{backendKind:'app-server',workerId:'valid-worker',workerGeneration:1};
 const payload=new Proxy(plain,{getOwnPropertyDescriptor(t,k){traps++;job.executionReceipt=false;return Reflect.getOwnPropertyDescriptor(t,k);}});
 u.recoverExecution=(_id:string,p:any,a:any)=>{(kind==='progress'?p:a)(payload);return Promise.resolve(result);};
 try{jobs.attachUpstream(u,sessions);await job.promise;for(let i=0;i<4;i++)await Promise.resolve();jobs.pinNonforcingShutdown();record('descriptor-'+kind,{traps,sql:state.listJobs()[0],ack:ack.mock.calls.length,resource:jobs.observeNonforcingExit()});expect(traps).toBeGreaterThan(0);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(ack).not.toHaveBeenCalled();expect(state.listJobs()[0].executionReceipt).toBe(true);
 }finally{state.close();}
});
test('NEW normal asynchronous original progress/assignment preserve native lifetime and ACK',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any;const gate=new Promise<void>(r=>go=r);u.recoverExecution=async function(this:any,_id:string,p:any,a:any){expect(this).toBe(u);await gate;p({progress:.5,total:1});a({backendKind:'app-server',workerId:'valid-late',workerGeneration:1,threadId:'late-thread'});return result;};
 try{jobs.attachUpstream(u,sessions);go();await job.promise;expect(job.status).toBe('completed');expect(job.threadId).toBe('late-thread');expect(job.sessionDecision.threadId).toBe('late-thread');expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{go();state.close();}
});
test('NEW pinned late original callbacks retain payloads without writes or ACK',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any;const gate=new Promise<void>(r=>go=r),praw={progress:.5,total:1},araw={backendKind:'app-server',workerId:'pinned-late',workerGeneration:1};u.recoverExecution=async (_id:string,p:any,a:any)=>{await gate;p(praw);a(araw);return result;};
 try{jobs.attachUpstream(u,sessions);const owned=job.promise;const before=state.listJobs()[0];jobs.pinNonforcingShutdown();go();await owned;expect(state.listJobs()[0]).toEqual(before);expect(ack).not.toHaveBeenCalled();const obs=(jobs as any).nonforcingLateObservations.get(job.jobId);expect(obs.some((x:any)=>x.value===praw)).toBe(true);expect(obs.some((x:any)=>x.value===araw)).toBe(true);expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{go();state.close();}
});

for(const [field,value] of [['authBoundary','foreign-owner'],['backendKind','foreign-backend'],['workerPid',789],['processGroupId',789],['upstreamRequestId','foreign-turn'],['scopeId','foreign-scope'],['requestHash','foreign-hash'],['sandbox','workspace-write']] as const)test('NEW original async producer cannot rewrite '+field,async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let go:any;const gate=new Promise<void>(r=>go=r);const before=state.listJobs()[0];
 u.recoverExecution=async()=>{await gate;(job as any)[field]=value;return result;};
 try{jobs.attachUpstream(u,sessions);go();await job.promise;expect(state.listJobs()[0]).toEqual(before);expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{go();state.close();}
});
