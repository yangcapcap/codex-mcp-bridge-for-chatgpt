import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered};}


test('NEW upstream-error callback result accessor pin stops subsequent text getter',async()=>{
 const {state,jobs}=fixture();let contentReads=0,textReads=0;
 try{const job=jobs.start(input(),async()=>({...result,isError:true}),(value:any)=>{const item:any={type:'text'};Object.defineProperty(item,'text',{get(){textReads++;return 'late-body';}});Object.defineProperty(value,'content',{get(){contentReads++;jobs.pinNonforcingShutdown();return [item];}});});await job.promise;record('callback-result-accessor',{contentReads,textReads,status:job.status,sql:state.listJobs()[0].status,resource:jobs.observeNonforcingExit()});expect(textReads).toBe(0);}finally{state.close();}
});
test('NEW original rejected producer store committed pin stops all live Job setter application',async()=>{
 let jobs:any,job:any,armed=false,reads=0;const original=new Error('original-producer');const state=new BridgeStateStore({file:':memory:',onTransactionCommitted:()=>{if(!armed)return;armed=false;Object.setPrototypeOf(job,{set result(_v:any){reads++;},set resultBytes(_v:any){reads++;}});jobs.pinNonforcingShutdown();}});jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()]});
 try{job=jobs.start(input(),async()=>{throw original;});const p=job.promise;armed=true;await p;record('rejected-store-commit-pin',{reads,status:job.status,sql:state.listJobs()[0].status,resource:jobs.observeNonforcingExit(),deferred:(jobs as any).deferredSettlements.get(job.jobId)?.kind});expect(reads).toBe(0);}finally{if(job)Object.setPrototypeOf(job,Object.prototype);state.close();}
});
test.each(['normal','upstream-error'])('NEW %s callback readonly status cannot erase original outcome history',async kind=>{
 const {state,jobs}=fixture();let undoCalls=0,caught:any;const returned:any=kind==='normal'?result:{...result,isError:true};let job:any;
 try{job=jobs.start(input(),async()=>returned,(_r,current)=>{Object.defineProperty(current,'status',{value:current.status,writable:false,configurable:false,enumerable:true});return ()=>{undoCalls++;};});const id=job.jobId,p=job.promise;await p.catch((error:any)=>{caught=error;});jobs.pinNonforcingShutdown();record('readonly-status-'+kind,{undoCalls,promiseRejected:caught!==undefined,status:job.status,sql:state.listJobs()[0].status,rawDeferred:(jobs as any).deferredSettlements.get(id)?.kind,resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect((jobs as any).deferredSettlements.get(id)?.kind).toBe('resolved');}finally{state.close();}
});
test.each(['project','request','execution','nested-session'])('NEW callback %s authority mutation preserves original resolved owner and raw evidence',async kind=>{
 const {state,jobs}=fixture();const original=input();const raw={unsupported:'callback'};let current:any;
 try{const job=jobs.start(original,async()=>result,(_r,j)=>{current=j;if(kind==='project')j.projectId='changed-project';if(kind==='request')j.requestHash='b'.repeat(64);if(kind==='execution')j.executionDecision={arbitrary:'changed'} as any;if(kind==='nested-session')j.sessionDecision.reason='explicit-thread';return raw as any;});const id=job.jobId,p=job.promise;await p;expect((jobs as any).nonforcingLateObservations.get(id)).toContainEqual({kind:'completion-callback-result',value:raw});expect((jobs as any).deferredSettlements.get(id)?.kind).toBe('resolved');expect((jobs as any).jobs.get(id)).toBe(current);expect(state.listJobs()[0].status).toBe('running');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW ownership-validation failure preserves returned original undo capability',async()=>{
 const {state,jobs}=fixture();let undoCalls=0;const undo=()=>{undoCalls++;};
 try{const job=jobs.start(input(),async()=>result,(_r,current)=>{current.authBoundary='changed';return undo;});const id=job.jobId;await job.promise;expect(undoCalls).toBe(0);expect((jobs as any).nonforcingLateObservations.get(id)).toContainEqual({kind:'completion-undo-capability',value:undo});expect((jobs as any).deferredSettlements.get(id)?.kind).toBe('resolved');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW normal valid undo capability remains unused and does not fabricate UNKNOWN',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn(),undo=vi.fn();jobs.attachUpstream(upstream(ack));try{const job=jobs.start(input(),async()=>result,()=>undo);await job.promise;expect(undo).not.toHaveBeenCalled();expect(ack).toHaveBeenCalledOnce();expect(job.status).toBe('completed');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test.each(['normal','upstream-error'])('NEW %s store committed pin retains original outcome without terminal live application',async kind=>{
 let jobs:any,job:any,armed=false;const state=new BridgeStateStore({file:':memory:',onTransactionCommitted:()=>{if(armed){armed=false;jobs.pinNonforcingShutdown();}}});jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()]});
 try{job=jobs.start(input(),async()=>kind==='normal'?result:{...result,isError:true});const p=job.promise,id=job.jobId;armed=true;await p;expect(job.status).toBe('running');expect((jobs as any).deferredSettlements.get(id)?.kind).toBe('resolved');expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW nested authority Proxy pin cannot invoke later observer/getter',async()=>{
 const {state,jobs}=fixture();let first=0,later=0;
 try{const job=jobs.start(input(),async()=>result,(_r,current)=>{current.executionDecision=new Proxy({nested:true},{ownKeys(t){first++;jobs.pinNonforcingShutdown();return Reflect.ownKeys(t);},getOwnPropertyDescriptor(t,k){later++;return Reflect.getOwnPropertyDescriptor(t,k);}}) as any;});await job.promise;expect(first).toBe(1);expect(later).toBe(0);expect(state.listJobs()[0].status).toBe('running');expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('NEW callback throw after corrupting identity retains original thrown raw value and key',async()=>{
 const {state,jobs}=fixture();const raw={original:'exception'};
 try{const job=jobs.start(input(),async()=>result,(_r,current)=>{current.jobId='changed';throw raw;});const id=[...(jobs as any).jobs.keys()][0];await job.promise;expect((jobs as any).nonforcingLateObservations.get(id)).toContainEqual({kind:'completion-callback-error',value:raw});expect((jobs as any).deferredSettlements.get(id)?.kind).toBe('resolved');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});

test.each(['normal','upstream-error'])('ROOT %s nonextensible callback preserves exact original result before SQL',async kind=>{
 const {state,jobs}=fixture();const returned:any=kind==='normal'?result:{...result,isError:true};
 try{const job=jobs.start(input(),async()=>returned,(_r,current)=>{Object.preventExtensions(current);});const id=job.jobId;await job.promise;expect(state.listJobs()[0].status).toBe('running');expect((jobs as any).deferredSettlements.get(id)?.result).toBe(returned);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
test('ROOT poisoned callback argument is retained separately from the exact producer outcome',async()=>{
 const {state,jobs}=fixture();let argument:any;let getters=0;const returned:any={content:[{type:'text',text:'original-before-callback'}],isError:true};
 try{const job=jobs.start(input(),async()=>returned,(value:any)=>{argument=value;Object.defineProperty(value,'content',{get(){getters++;return [];}});});const id=job.jobId;await job.promise;expect(getters).toBe(0);expect((jobs as any).deferredSettlements.get(id)?.result).toBe(returned);expect((jobs as any).nonforcingLateObservations.get(id)).toContainEqual({kind:'completion-result-data',value:argument});expect(returned.content[0].text).toBe('original-before-callback');expect(state.listJobs()[0].status).toBe('running');jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{state.close();}
});
