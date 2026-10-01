// Original 57696f1 review assertions retained; only observation sink adapted.
import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered};}


test.each(['completion','assignment'])('NEW %s callback cannot erase original executionReceipt ownership',async kind=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let job:any,id='';
 const alter=(_r:any,current:any)=>{current.executionReceipt=false;};
 try{job=jobs.start(input(),async(_p,a)=>{if(kind==='assignment')a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;},kind==='completion'?alter:undefined,undefined,false,kind==='assignment'?alter:undefined);id=job.jobId;const promise=job.promise;await promise;jobs.pinNonforcingShutdown();record('receipt-erasure-'+kind,{liveReceipt:job.executionReceipt,sqlReceipt:state.listJobs()[0].executionReceipt,status:job.status,ackCalls:ack.mock.calls.length,rawDeferred:(jobs as any).deferredSettlements.get(id)?.kind,resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test.each(['completion','assignment'])('NEW %s callback cannot replace original worker generation binding',async kind=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));const alter=(_r:any,current:any)=>{current.workerId='replacement-worker';current.workerGeneration=99;};
 try{const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;},kind==='completion'?alter:undefined,undefined,false,kind==='assignment'?alter:undefined);const id=job.jobId;await job.promise;jobs.pinNonforcingShutdown();const sql=state.listJobs()[0];record('worker-replacement-'+kind,{liveWorker:job.workerId,liveGeneration:job.workerGeneration,sqlWorker:sql.workerId,sqlGeneration:sql.workerGeneration,status:job.status,ackCalls:ack.mock.calls.length,rawDeferred:(jobs as any).deferredSettlements.get(id)?.kind,resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW completion callback cannot silently replace admitted auth owner',async()=>{
 const {state,jobs}=fixture({authBoundary:()=> 'original-owner'});const ack=vi.fn();jobs.attachUpstream(upstream(ack));
 try{const job=jobs.start(input(),async()=>result,(_r,current)=>{current.authBoundary='replacement-owner';});const id=job.jobId;await job.promise;jobs.pinNonforcingShutdown();record('auth-replacement',{liveAuth:job.authBoundary,sqlAuth:state.listJobs()[0].authBoundary,status:job.status,ackCalls:ack.mock.calls.length,rawDeferred:(jobs as any).deferredSettlements.get(id)?.kind,resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test.each(['throw','false','pin'])('NEW assignment owner mutation %s retains original ID and producer outcome',async kind=>{
 const {state,jobs}=fixture();const raw={exact:'callback'};let job:any,id='';
 try{job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;},undefined,undefined,false,(_a,current)=>{current.jobId='changed';if(kind==='throw')throw raw;if(kind==='pin')jobs.pinNonforcingShutdown();return kind==='false'?false:undefined;});id=[...(jobs as any).jobs.keys()][0];const p=job.promise;await p;expect((jobs as any).deferredSettlements.get(id)?.result).toEqual(result);if(kind==='throw')expect((jobs as any).nonforcingLateObservations.get(id)).toContainEqual({kind:'assignment-callback-error',value:raw});jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW nested Job Proxy descriptor pin stops subsequent snapshots',async()=>{
 const {state,jobs}=fixture();let first=0,second=0;
 try{const job=jobs.start(input(),async()=>result,(_r,current)=>{current.sessionDecision=new Proxy(current.sessionDecision,{getOwnPropertyDescriptor(t,k){first++;jobs.pinNonforcingShutdown();return Reflect.getOwnPropertyDescriptor(t,k);}});Object.defineProperty(current,'nestedLater',{value:new Proxy({x:1},{ownKeys(t){second++;return Reflect.ownKeys(t);}}),enumerable:true,configurable:true});});await job.promise;expect(first).toBe(1);expect(second).toBe(0);expect(state.listJobs()[0].status).toBe('running');expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test.each(['throw','pin-throw'])('NEW cleanup %s retains first raw error and reaches or retains all later handles',kind=>{
 const {state,jobs,settings,catalog,registered}=application();const raw={exact:'first-cleanup'};let laterCalls=0;const later=()=>{laterCalls++;};settings.subscribeChanges=()=>()=>{if(kind==='pin-throw')jobs.pinNonforcingShutdown();throw raw;};catalog.subscribe=()=>later;const unsub=registered.applicationService.subscribeChanges!(()=>{});
 try{let caught:any;try{unsub();}catch(e){caught=e;}expect(caught).toBe(raw);const all=[...(jobs as any).nonforcingLateObservations.values()].flat();expect(all).toContainEqual({kind:'listener-error',value:raw});expect(laterCalls>0||all.some((r:any)=>r.value===later)).toBe(true);if(kind==='pin-throw')expect(laterCalls).toBe(0);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{registered.dispose();state.close();}
});
test('NEW rejected registration thenable preserves raw value without invoking then',()=>{
 const {state,jobs,catalog,registered}=application();let reads=0;const raw:any={};Object.defineProperty(raw,'then',{get(){reads++;throw Error('forbidden');}});catalog.subscribe=()=>raw;
 try{expect(()=>registered.applicationService.subscribeChanges!(()=>{})).toThrow('UNCONFIRMED');expect(reads).toBe(0);expect((jobs as any).nonforcingLateObservations.get('application-subscription')).toContainEqual({kind:'registration-result',value:raw});jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{registered.dispose();state.close();}
});
test('NEW ordinary completion may record thread linkage without changing original owner',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));try{const job=jobs.start(input(),async()=>result,(_r,current)=>{current.sessionDecision.threadId='valid-thread';current.threadId='valid-thread';});const id=job.jobId,p=job.promise;await p;expect(job.jobId).toBe(id);expect(job.promise).toBe(p);expect(job.threadId).toBe('valid-thread');expect(job.status).toBe('completed');expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});

test.each(['normal','upstream-error'])('NEW %s terminal assignment cannot invoke inherited setter continuation after pin',async kind=>{
 const {state,jobs}=fixture();let first=0,afterPin=0;let job:any;const returned:any=kind==='normal'?result:{...result,isError:true};
 try{job=jobs.start(input(),async()=>returned,(_r,current)=>{Object.setPrototypeOf(current,{set result(_v:any){first++;jobs.pinNonforcingShutdown();},set resultBytes(_v:any){afterPin++;}});});const p=job.promise;await p;record('inherited-setter-'+kind,{first,afterPin,status:job.status,sql:state.listJobs()[0].status,resource:jobs.observeNonforcingExit()});expect(afterPin).toBe(0);}finally{if(job)Object.setPrototypeOf(job,Object.prototype);state.close();}
});
