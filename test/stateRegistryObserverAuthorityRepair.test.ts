import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered,u};}



test.each(['false','object','promise'])('NEW undo %s returned value survives authority-validation failure',async kind=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let resolve:any;const raw:any=kind==='false'?false:kind==='object'?{raw:'undo-return'}:new Promise(r=>resolve=r);const upsert=state.upsertJob.bind(state);let conflict=false,undoCalls=0;
 state.upsertJob=((j:any)=>{if(j.status==='completed'&&!conflict){conflict=true;throw Error('private terminal conflict');}return upsert(j);}) as any;
 try{const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;},(_r,current)=>()=>{undoCalls++;current.workerId='unsupported-undo-worker';return raw;});const id=job.jobId,p=job.promise;await p;jobs.pinNonforcingShutdown();const obs=(jobs as any).nonforcingLateObservations.get(id)||[];record('undo-raw-'+kind,{undoCalls,retainedRaw:obs.some((x:any)=>x.value===raw),kinds:obs.map((x:any)=>x.kind),originalResult:(jobs as any).deferredSettlements.get(id)?.result===result,promiseOriginal:job.promise===p,ackCalls:ack.mock.calls.length,resource:jobs.observeNonforcingExit()});expect(undoCalls).toBe(1);expect((jobs as any).deferredSettlements.get(id)?.result).toBe(result);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(obs.some((x:any)=>x.value===raw)).toBe(true);}finally{resolve?.();state.close();}
});
test.each(['prototype','accessor'])('NEW unused original undo retained when %s preflight rejects store-mutated job',async kind=>{
 const {state,jobs}=fixture();jobs.attachUpstream(upstream());const undo=vi.fn();const upsert=state.upsertJob.bind(state);let conflict=false,job:any,reads=0;let originalProto:any,descriptor:any;
 state.upsertJob=((j:any)=>{if(j.status==='completed'&&!conflict){conflict=true;if(kind==='prototype')Object.setPrototypeOf(job,{unsupported:true});else Object.defineProperty(job,'status',{get(){reads++;return 'running';},enumerable:true,configurable:true});throw Error('private terminal conflict after data contamination');}return upsert(j);}) as any;
 try{job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;},()=>undo);originalProto=Object.getPrototypeOf(job);descriptor=Object.getOwnPropertyDescriptor(job,'status');const id=job.jobId,p=job.promise;await p;jobs.pinNonforcingShutdown();const obs=(jobs as any).nonforcingLateObservations.get(id)||[];record('undo-preflight-'+kind,{undoCalls:undo.mock.calls.length,reads,retainedUndo:obs.some((x:any)=>x.value===undo),kinds:obs.map((x:any)=>x.kind),originalResult:(jobs as any).deferredSettlements.get(id)?.result===result,resource:jobs.observeNonforcingExit()});expect(undo).not.toHaveBeenCalled();expect(reads).toBe(0);expect((jobs as any).deferredSettlements.get(id)?.result).toBe(result);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(obs.some((x:any)=>x.value===undo)).toBe(true);}finally{if(job){Object.setPrototypeOf(job,originalProto);Object.defineProperty(job,'status',descriptor);}state.close();}
});
test.each(['worker','receipt'])('NEW application observer cannot change terminal %s authority before ACK baseline',async kind=>{
 const f=application();const ack=vi.fn();f.u.acknowledgeExecution=ack;let job:any,calls=0;const unsub=f.registered.applicationService.subscribeChanges(()=>{if(job?.status==='completed'){calls++;if(kind==='worker'){job.workerId='observer-worker';job.workerGeneration=99;}else job.executionReceipt=false;}});
 try{job=f.jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;});await job.promise;f.jobs.pinNonforcingShutdown();record('observer-authority-'+kind,{calls,worker:job.workerId,sqlWorker:f.state.listJobs()[0].workerId,ackCalls:ack.mock.calls.length,resource:f.jobs.observeNonforcingExit()});expect(calls).toBeGreaterThanOrEqual(1);expect(f.jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{unsub();f.registered.dispose();f.state.close();}
});
test('NEW async ACK rejection retains exact raw error identity without formatting',async()=>{
 const {state,jobs}=fixture();const raw:any={cause:'raw'};let reads=0;Object.defineProperty(raw,'message',{get(){reads++;throw Error('must not format');}});jobs.attachUpstream(upstream(()=>Promise.reject(raw)));
 try{const job=jobs.start(input(),async()=>result);const id=job.jobId;await job.promise;await Promise.resolve();jobs.pinNonforcingShutdown();expect(reads).toBe(0);expect((jobs as any).nonforcingLateObservations.get(id).some((x:any)=>x.value===raw)).toBe(true);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW async ACK ordinary undefined resolution remains resource EXIT',async()=>{
 const {state,jobs}=fixture();jobs.attachUpstream(upstream(()=>Promise.resolve()));try{const job=jobs.start(input(),async()=>result);await job.promise;await Promise.resolve();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test('NEW ACK getter owner mutation prevents captured callback delegation',async()=>{
 const {state,jobs}=fixture();let job:any,reads=0;const ack=vi.fn(),u:any=upstream();Object.defineProperty(u,'acknowledgeExecution',{get(){reads++;job.workerId='lookup-worker';return ack;}});jobs.attachUpstream(u);
 try{job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;});await job.promise;jobs.pinNonforcingShutdown();expect(reads).toBe(1);expect(ack).not.toHaveBeenCalled();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW ordinary retry accepts matching thread metadata undo and preserved receiver behavior',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));const upsert=state.upsertJob.bind(state);let conflict=false,calls=0;state.upsertJob=((j:any)=>{if(j.status==='completed'&&!conflict){conflict=true;throw Error('private one conflict');}return upsert(j);}) as any;
 try{const job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;},(_r,current)=>()=>{calls++;current.threadId='undo-thread';current.sessionDecision.threadId='undo-thread';});await job.promise;expect(calls).toBe(1);expect(job.status).toBe('completed');expect(job.workerId).toBe('original-worker');expect(ack).toHaveBeenCalledOnce();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});

test('NEW async ACK authorization mutation remains UNKNOWN after native resolution',async()=>{
 const {state,jobs}=fixture();let resolve:any,job:any;const pending=new Promise<void>(r=>resolve=r);jobs.attachUpstream(upstream(()=>pending));try{job=jobs.start(input(),async()=>result);await job.promise;job.authBoundary='late-unsupported-owner';resolve();await Promise.resolve();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect((jobs as any).nonforcingLateObservations.get(job.jobId).some((x:any)=>x.kind==='ack-fulfillment-boundary')).toBe(true);}finally{resolve?.();state.close();}
});

test('registry change observer cannot replace worker generation and receive an execution ACK',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let job:any;
 jobs.subscribeChanges(()=>{if(job?.status==='completed')job.workerGeneration=700;});
 try{job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;});await job.promise;
 expect(state.listJobs()[0].workerGeneration).toBe(1);expect(ack).not.toHaveBeenCalled();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('terminal waiter cannot remove the original receipt and receive an execution ACK',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 try{const job=jobs.start(input(),async()=>{await gate;return result;});(jobs as any).terminalWaiters.set(job.jobId,new Set([()=>{job.executionReceipt=false;}]));release();await job.promise;
 expect(ack).not.toHaveBeenCalled();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{release?.();state.close();}
});
