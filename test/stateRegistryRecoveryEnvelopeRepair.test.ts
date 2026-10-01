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

for(const mode of ['body-receipt','body-worker','lookup-receipt'])test('FRESH recovery '+mode+' cannot rewrite original admission authority before outcome',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture();const ack=vi.fn(),u:any=upstream(ack);let calls=0,lookups=0;const id=job.jobId,originalReceipt=job.executionReceipt;
 const recover=function(this:any){expect(this).toBe(u);calls++;if(mode==='body-receipt')job.executionReceipt=false;if(mode==='body-worker'){job.workerId='unsourced-recovery-worker';job.workerGeneration=91;}return Promise.resolve(result);};
 if(mode==='lookup-receipt')Object.defineProperty(u,'recoverExecution',{get(){lookups++;job.executionReceipt=false;return recover;}});else u.recoverExecution=recover;
 try{jobs.attachUpstream(u,sessions);await job.promise;for(let i=0;i<4;i++)await Promise.resolve();jobs.pinNonforcingShutdown();record('recovery-authority-'+mode,{calls,lookups,originalReceipt,liveReceipt:job.executionReceipt,worker:job.workerId,generation:job.workerGeneration,liveStatus:job.status,sqlReceipt:state.listJobs()[0].executionReceipt,sqlWorker:state.listJobs()[0].workerId,ackCalls:ack.mock.calls.length,resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(ack).not.toHaveBeenCalled();}finally{state.close();}
});
test('FRESH native recovery own then getter is ignored and original receiver preserved',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);let reads=0,calls=0;const native=Promise.resolve(result);Object.defineProperty(native,'then',{get(){reads++;throw Error('no property lookup');}});u.recoverExecution=function(this:any){expect(this).toBe(u);calls++;return native;};try{jobs.attachUpstream(u,sessions);await job.promise;for(let i=0;i<4;i++)await Promise.resolve();expect(reads).toBe(0);expect(calls).toBe(1);expect(job.status).toBe('completed');expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test('FRESH recovered native Promise settlement, not completed status, confirms EXIT',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),u:any=upstream();let finish:any,calls=0;const native=new Promise<any>(r=>finish=r);u.recoverExecution=()=>{calls++;return native;};try{jobs.attachUpstream(u,sessions);const p=job.promise;expect(calls).toBe(1);job.status='completed';jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(false);job.status='running';finish(result);await p;expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{finish(result);for(let i=0;i<20;i++)await Promise.resolve();state.close();}
});
test('FRESH recovery Proxy rejected without constructor/prototype/then traps and keeps original raw capability',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),u:any=upstream();let traps=0;const raw=new Proxy(Promise.resolve(result),{getOwnPropertyDescriptor(t,k){traps++;return Reflect.getOwnPropertyDescriptor(t,k);},getPrototypeOf(t){traps++;return Reflect.getPrototypeOf(t);},get(t,k,r){traps++;return Reflect.get(t,k,r);}});u.recoverExecution=()=>raw;try{expect(()=>jobs.attachUpstream(u,sessions)).toThrow('STATE_RECOVERY_PROMISE_OWNER_UNCONFIRMED');expect(traps).toBe(0);expect((jobs as any).nonforcingLateObservations.get(job.jobId).some((x:any)=>x.value===raw)).toBe(true);expect((jobs as any).recoveryJobs.has(job.jobId)).toBe(true);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});

test('valid native recovery rejection after pin retains original reason without unhandled event',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),u:any=upstream(),raw={original:'after pin rejection'};
 const events:unknown[]=[];const listener=(reason:unknown)=>events.push(reason);process.on('unhandledRejection',listener);
 u.recoverExecution=()=>{jobs.pinNonforcingShutdown();return Promise.reject(raw);};
 try{jobs.attachUpstream(u,sessions);await new Promise<void>(resolve=>setImmediate(resolve));
  expect(events).toEqual([]);expect((jobs as any).nonforcingLateObservations.get(job.jobId).some((x:any)=>x.value===raw)).toBe(true);
  expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');
 }finally{process.off('unhandledRejection',listener);state.close();}
});
test('unsupported recovery constructor after pin is retained without invoking its getter',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),u:any=upstream();let reads=0;
 const native=Promise.resolve(result);Object.defineProperty(native,'constructor',{get(){reads++;throw Error('must-not-invoke');}});
 u.recoverExecution=()=>{jobs.pinNonforcingShutdown();return native;};
 try{jobs.attachUpstream(u,sessions);for(let i=0;i<4;i++)await Promise.resolve();expect(reads).toBe(0);
  expect((jobs as any).nonforcingLateObservations.get(job.jobId).some((x:any)=>x.value===native)).toBe(true);
  expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');
 }finally{state.close();}
});
test('synchronous original progress and assignment can advance a recovered native envelope',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);
 u.recoverExecution=(_id:string,onProgress:any,onAssigned:any)=>{
  onProgress({progress:0.5,total:1});
  onAssigned({backendKind:'app-server',workerId:'native-original',workerGeneration:1,upstreamRequestId:'native-turn'});
  return Promise.resolve(result);
 };
 try{jobs.attachUpstream(u,sessions);await job.promise;expect(job.status).toBe('completed');expect(job.workerId).toBe('native-original');
  expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);
 }finally{state.close();}
});
test('progress callback cannot mask a direct recovery authority rewrite',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture(),ack=vi.fn(),u:any=upstream(ack);
 u.recoverExecution=(_id:string,onProgress:any)=>{job.executionReceipt=false;onProgress({progress:0.5,total:1});return Promise.resolve(result);};
 try{jobs.attachUpstream(u,sessions);await job.promise;jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');
  expect(ack).not.toHaveBeenCalled();expect(state.listJobs()[0].executionReceipt).toBe(true);
 }finally{state.close();}
});
