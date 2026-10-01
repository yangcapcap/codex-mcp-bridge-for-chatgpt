import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered,u};}








for(const kind of ['resolved','rejected'])test('NEW original outcome marker cannot hide actual terminal retry '+kind,async()=>{
 const {state,jobs}=fixture(),ack=vi.fn();jobs.attachUpstream(upstream(ack));const upsert=state.upsertJob.bind(state);let failures=0,settled=false,launched=0;const raw=new Error('original-rejected-producer');state.upsertJob=((j:any)=>{if(j.status==='completed'||j.status==='failed'){failures++;throw Error('owned fixture retry conflict');}return upsert(j);}) as any;
 const job=jobs.start(input(),async()=>{launched++;if(kind==='rejected')throw raw;return result;}),p=job.promise;void p.then(()=>{settled=true;});
 try{for(let i=0;i<20;i++)await Promise.resolve();expect(launched).toBe(1);expect(failures).toBeGreaterThan(0);expect(settled).toBe(false);const pending=jobs.pendingTerminalCommit(job);if(kind==='resolved')expect(pending).not.toBeNull();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('timeout');job.status='completed';const resource=jobs.observeNonforcingExit();record('retry-'+kind,{launched,failures,promiseSettled:settled,sqlStatus:state.listJobs()[0].status,liveStatus:job.status,pendingCommit:!!pending,resource});expect(resource.exited).toBe(false);}finally{job.status='running';await p;expect((jobs as any).deferredSettlements.get(job.jobId)?.kind).toBe(kind);state.close();}
});
async function recoveryFixture(){const f=fixture();f.jobs.attachUpstream(upstream());const seed=f.jobs.start(input(),async()=>result);f.jobs.pinNonforcingShutdown();await seed.promise;const recovered=new CodexJobRegistry({stateStore:f.state,allowedRoots:[process.cwd()],recoverExecutions:true});const job=recovered.get(seed.jobId)!;return {state:f.state,jobs:recovered,job,sessions:new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]})};}
for(const kind of ['then-getter','job-promise-accessor'])test('NEW recovery callback pin stops subsequent configurable lookup '+kind,async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture();let reads=0,sets=0,calls=0,finish:any,pending:any,outerError:any;const original=Object.getOwnPropertyDescriptor(job,'promise')!,native=new Promise<any>(r=>finish=r);const u:any=upstream();u.recoverExecution=()=>{calls++;jobs.pinNonforcingShutdown();if(kind==='then-getter'){const value:any={};Object.defineProperty(value,'then',{get(){reads++;throw {raw:'late then getter'};}});pending=value;return value;}Object.defineProperty(job,'promise',{get(){reads++;return Promise.resolve();},set(_v){sets++;},configurable:true,enumerable:true});pending=native;return native;};
 try{try{jobs.attachUpstream(u,sessions);}catch(e){outerError=e;}record('recovery-pin-'+kind,{calls,reads,sets,threw:!!outerError,pinned:jobs.nonforcingShutdownPinned,resource:jobs.observeNonforcingExit()});expect(calls).toBe(1);expect(reads).toBe(0);expect(sets).toBe(0);}finally{Object.defineProperty(job,'promise',original);finish(result);for(let i=0;i<20;i++)await Promise.resolve();state.close();}
});
for(const status of ['completed','interrupted'])test('NEW ordinary initial terminal load '+status+' stays resource EXIT',async()=>{
 const f=fixture();try{const original=f.jobs.start(input(),async()=>result);await original.promise;const persisted=f.state.listJobs()[0];f.state.upsertJob({...persisted,status:status as any,terminalOrigin:status==='interrupted'?'bridge-restart':persisted.terminalOrigin});const recovered=new CodexJobRegistry({stateStore:f.state,allowedRoots:[process.cwd()],recoverExecutions:true});expect(recovered.get(original.jobId)?.status).toBe(status);recovered.pinNonforcingShutdown();expect(recovered.observeNonforcingExit().exited).toBe(true);}finally{f.state.close();}
});
test('NEW ordinary active restart without execution recovery becomes interrupted and quiet',async()=>{
 const f=fixture();try{const seed=f.jobs.start(input(),async()=>result);f.jobs.pinNonforcingShutdown();await seed.promise;const restored=new CodexJobRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});expect(restored.get(seed.jobId)?.status).toBe('interrupted');restored.pinNonforcingShutdown();expect(restored.observeNonforcingExit().exited).toBe(true);}finally{f.state.close();}
});
test('NEW actual recovered native producer remains tracked across display status changes',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture();let finish:any,calls=0;const native=new Promise<any>(r=>finish=r),u:any=upstream();u.recoverExecution=()=>{calls++;return native;};try{jobs.attachUpstream(u,sessions);const p=job.promise;expect(calls).toBe(1);jobs.pinNonforcingShutdown();job.status='completed';expect(jobs.observeNonforcingExit().exited).toBe(false);job.status='running';finish(result);await p;expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{finish(result);for(let i=0;i<20;i++)await Promise.resolve();state.close();}
});
for(const key of ['jobId','promise'])test('NEW original '+key+' getter rejected at pin without invocation',async()=>{
 const f=fixture();let finish:any,reads=0;const native=new Promise<any>(r=>finish=r),job=f.jobs.start(input(),async()=>native),p=job.promise,d=Object.getOwnPropertyDescriptor(job,key)!;try{await Promise.resolve();Object.defineProperty(job,key,{get(){reads++;throw Error('must not read');},enumerable:true,configurable:true});f.jobs.pinNonforcingShutdown();expect(f.jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(reads).toBe(0);}finally{Object.defineProperty(job,key,d);finish(result);await p;f.state.close();}
});

test('NEW recovery body raw throw after pin stays owned UNKNOWN with original error retained',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture();const raw={original:'recover-body-error'},u:any=upstream();let calls=0,caught:any;u.recoverExecution=()=>{calls++;jobs.pinNonforcingShutdown();throw raw;};try{try{jobs.attachUpstream(u,sessions);}catch(e){caught=e;}const all=[...(jobs as any).nonforcingLateObservations.values()].flat() as any[],resource=jobs.observeNonforcingExit();record('recover-body-error',{calls,caughtOriginal:caught===raw,rawRetained:all.some(x=>x.value===raw),recoveryJobsHas:(jobs as any).recoveryJobs.has(job.jobId),resource});expect(calls).toBe(1);expect(resource.outcome).toBe('uncertain');expect(all.some(x=>x.value===raw)).toBe(true);}finally{state.close();}
});
test('NEW ordinary native recovered completion confirms original terminal and ACK once',async()=>{
 const {state,jobs,job,sessions}=await recoveryFixture();const ack=vi.fn(),u:any=upstream(ack);let calls=0;u.recoverExecution=()=>{calls++;return Promise.resolve(result);};try{jobs.attachUpstream(u,sessions);await job.promise;expect(calls).toBe(1);expect(job.status).toBe('completed');expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
