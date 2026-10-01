import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered,u};}





test('NEW owner inventory iterator pin blocks subsequent subscription delegation',()=>{
 const {state,jobs}=fixture();const map=(jobs as any).jobs;let reads=0,calls=0,bodyPinned=false;const cleanup=vi.fn();Object.defineProperty(map,Symbol.iterator,{get(){reads++;jobs.pinNonforcingShutdown();return Map.prototype.entries;},configurable:true});
 try{expect(()=>jobs.registerApplicationSubscription(()=>{calls++;bodyPinned=jobs.nonforcingShutdownPinned;return cleanup;})).toThrow();const all=[...(jobs as any).nonforcingLateObservations.values()].flat();record('inventory-pin',{reads,calls,bodyPinned,cleanupCalls:cleanup.mock.calls.length,cleanupRetained:all.some((x:any)=>x.value===cleanup),inflight:(jobs as any).registryCallbacksInFlight,resource:jobs.observeNonforcingExit()});expect(bodyPinned).toBe(false);expect(reads).toBe(0);expect(calls).toBe(0);}finally{delete map[Symbol.iterator];state.close();}
});
test('NEW owner inventory iterator throw retains exact raw error and releases callback counter',()=>{
 const {state,jobs}=fixture();const map=(jobs as any).jobs;const raw={original:'inventory-error'};let calls=0;Object.defineProperty(map,Symbol.iterator,{get(){throw raw;},configurable:true});
 try{let caught:any;try{jobs.publishApplicationChange(()=>{calls++;});}catch(error){caught=error;}delete map[Symbol.iterator];jobs.pinNonforcingShutdown();const all=[...(jobs as any).nonforcingLateObservations.values()].flat();record('inventory-throw',{calls,caughtOriginal:caught===raw,errorRetained:all.some((x:any)=>x.value===raw),inflight:(jobs as any).registryCallbacksInFlight,resource:jobs.observeNonforcingExit()});expect(caught).toBeInstanceOf(Error);expect(calls).toBe(0);expect((jobs as any).registryCallbacksInFlight).toBe(0);expect(all.some((x:any)=>x.value?.map===map&&x.value?.descriptors?.[Symbol.iterator]?.get)).toBe(true);}finally{delete map[Symbol.iterator];state.close();}
});
test('NEW postobserver owner iterator pin cannot return cleanup as ordinary success',()=>{
 const {state,jobs}=fixture();const map=(jobs as any).jobs;const cleanup=vi.fn();let reads=0,returned:any,error:any;
 try{try{returned=jobs.registerApplicationSubscription(()=>{Object.defineProperty(map,Symbol.iterator,{get(){reads++;jobs.pinNonforcingShutdown();return Map.prototype.entries;},configurable:true});return cleanup;});}catch(e){error=e;}delete map[Symbol.iterator];const all=[...(jobs as any).nonforcingLateObservations.values()].flat();record('post-inventory-pin',{reads,returnedCleanup:returned===cleanup,threw:!!error,cleanupRetained:all.some((x:any)=>x.value===cleanup),resource:jobs.observeNonforcingExit()});expect(returned).toBeUndefined();expect(error).toBeTruthy();expect(all.some((x:any)=>x.value===cleanup)).toBe(true);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{delete map[Symbol.iterator];state.close();}
});
test('NEW normal registration preserves exact synchronous cleanup without reading call accessor',()=>{
 const {state,jobs}=fixture();let reads=0,calls=0;const cleanup:any=()=>{calls++;};Object.defineProperty(cleanup,'call',{get(){reads++;throw Error('must not read');}});try{const value=jobs.registerApplicationSubscription(()=>cleanup);expect(value).toBe(cleanup);jobs.releaseApplicationSubscriptions([value]);expect(reads).toBe(0);expect(calls).toBe(1);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test.each(['return-promise','throw','map-delete'])('NEW registration %s keeps original active producer until settlement',async kind=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let finish:any,resolve:any,reads=0;const producer=new Promise<any>(r=>finish=r);const raw:any=kind==='return-promise'?new Promise(r=>resolve=r):{raw:'registration-error'};Object.defineProperty(raw,'message',{get(){reads++;throw Error('must not format');}});const cleanup=vi.fn();
 try{const job=jobs.start(input(),async()=>producer);const id=job.jobId,p=job.promise;expect(()=>jobs.registerApplicationSubscription(()=>{if(kind==='return-promise')return raw;if(kind==='map-delete'){(jobs as any).jobs.delete(id);return cleanup;}throw raw;})).toThrow();finish(result);await p;jobs.pinNonforcingShutdown();const all=[...(jobs as any).nonforcingLateObservations.values()].flat();expect(reads).toBe(0);expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.get(id)?.result).toBe(result);expect(all.some((x:any)=>x.value===(kind==='map-delete'?cleanup:raw))).toBe(true);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{resolve?.();finish?.(result);state.close();}
});
test('NEW supported registration cannot silently acquire a new Job owner',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));const cleanup=vi.fn();let job:any;try{expect(()=>jobs.registerApplicationSubscription(()=>{job=jobs.start(input(),async()=>result);return cleanup;})).toThrow();await job.promise;expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);expect(ack).not.toHaveBeenCalled();expect([...(jobs as any).nonforcingLateObservations.values()].flat().some((x:any)=>x.value===cleanup)).toBe(true);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW registry listener raw nonvoid return with worker mutation preserves both observations',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let job:any,calls=0;const raw={raw:'observer-return'};const unsub=jobs.subscribeChanges(()=>{if(job?.status==='completed'&&calls===0){calls++;job.workerGeneration=77;return raw;}});try{job=jobs.start(input(),async(_p,a)=>{a({backendKind:'app-server',workerId:'original-worker',workerGeneration:1});return result;});await job.promise;const all=[...(jobs as any).nonforcingLateObservations.values()].flat();expect(all.some((x:any)=>x.value===raw)).toBe(true);expect(all.some((x:any)=>x.kind==='observer-job-authority')).toBe(true);expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);expect(ack).not.toHaveBeenCalled();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{unsub();state.close();}
});
test.each(['nonvoid','pin'])('NEW undo %s retains original cleanup capability and producer',async kind=>{
 const {state,jobs}=fixture();jobs.attachUpstream(upstream());const upsert=state.upsertJob.bind(state);let conflict=false;state.upsertJob=((j:any)=>{if(j.status==='completed'&&!conflict){conflict=true;throw Error('private conflict');}return upsert(j);}) as any;const raw={undo:'raw-result'};const undo=vi.fn(()=>{if(kind==='pin')jobs.pinNonforcingShutdown();else return raw;});try{const job=jobs.start(input(),async()=>result,()=>undo);await job.promise;jobs.pinNonforcingShutdown();const obs=(jobs as any).nonforcingLateObservations.get(job.jobId)||[];expect(undo).toHaveBeenCalledOnce();expect(obs.some((x:any)=>x.value===undo)).toBe(true);if(kind==='nonvoid')expect(obs.some((x:any)=>x.value===raw)).toBe(true);expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});

test('NEW native ACK own constructor accessor preserves raw promise without delegation',async()=>{
 const {state,jobs}=fixture();let reads=0,resolve:any,calls=0;const pending=new Promise<void>(r=>resolve=r);Object.defineProperty(pending,'constructor',{get(){reads++;throw Error('must not read constructor');},configurable:true});jobs.attachUpstream(upstream(()=>{calls++;return pending;}));try{const job=jobs.start(input(),async()=>result);await job.promise;jobs.pinNonforcingShutdown();expect(calls).toBe(1);expect(reads).toBe(0);expect((jobs as any).executionAcknowledgements.get(job)?.value).toBe(pending);expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{resolve();state.close();}
});

test('NEW actual application subscription and cleanup preserve original receiver and capability',()=>{
 const f=application();let settingsReceiver:any,catalogReceiver:any,settingsCalls=0,catalogCalls=0;const settingsCleanup=()=>{settingsCalls++;},catalogCleanup=()=>{catalogCalls++;};(f.settings as any).subscribeChanges=function(this:any,_callback:any){settingsReceiver=this;return settingsCleanup;};f.catalog.subscribe=function(this:any,_callback:any){catalogReceiver=this;return catalogCleanup;};let unsubscribe:any;try{unsubscribe=f.registered.applicationService.subscribeChanges(()=>{});expect(settingsReceiver).toBe(f.settings);expect(catalogReceiver).toBe(f.catalog);unsubscribe();unsubscribe=undefined;expect(settingsCalls).toBe(1);expect(catalogCalls).toBe(1);f.jobs.pinNonforcingShutdown();expect(f.jobs.observeNonforcingExit().exited).toBe(true);}finally{unsubscribe?.();f.registered.dispose();f.state.close();}
});

test('original owner map replacement rejects before subscription and retains the replacement descriptor',()=>{
 const {state,jobs}=fixture(),original=(jobs as any).jobs,replacement=new Map();let calls=0;
 try{(jobs as any).jobs=replacement;expect(()=>jobs.registerApplicationSubscription(()=>{calls++;})).toThrow('INDEX_AUTHORITY');
 expect(calls).toBe(0);expect((jobs as any).registryCallbacksInFlight).toBe(0);
 const all=[...(jobs as any).nonforcingLateObservations.values()].flat();expect(all.some((x:any)=>x.value?.map===original&&x.value?.descriptor?.value===replacement)).toBe(true);
 (jobs as any).jobs=original;jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{(jobs as any).jobs=original;state.close();}
});
test('own owner-map get accessor is rejected without invoking it or losing callback accounting',()=>{
 const {state,jobs}=fixture(),map=(jobs as any).jobs;let reads=0,calls=0;Object.defineProperty(map,'get',{get(){reads++;throw Error('must not invoke');},configurable:true});
 try{expect(()=>jobs.publishApplicationChange(()=>{calls++;})).toThrow('INDEX_AUTHORITY');expect(reads).toBe(0);expect(calls).toBe(0);
 expect((jobs as any).registryCallbacksInFlight).toBe(0);delete map.get;jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{delete map.get;state.close();}
});
test('owner snapshot original exception is retained with its active producer and balanced counter',async()=>{
 const {state,jobs}=fixture(),ack=vi.fn();jobs.attachUpstream(upstream(ack));let finish:any;const producer=new Promise<any>(r=>finish=r);
 const raw={original:'snapshot-error'},original=(jobs as any).terminalJobData;const job=jobs.start(input(),async()=>producer);
 try{(jobs as any).terminalJobData=()=>{throw raw;};let caught;try{jobs.publishApplicationChange(()=>{});}catch(error){caught=error;}
 expect(caught).toBe(raw);expect((jobs as any).registryCallbacksInFlight).toBe(0);(jobs as any).terminalJobData=original;
 expect([...(jobs as any).nonforcingLateObservations.values()].flat().some((x:any)=>x.value===raw)).toBe(true);
 finish(result);await job.promise;expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.get(job.jobId)?.result).toBe(result);
 jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{(jobs as any).terminalJobData=original;finish(result);state.close();}
});
