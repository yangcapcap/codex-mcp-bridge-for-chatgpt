// Retained exact 2a31f00 independent reproducers; observation sink only adapted.
import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered};}


test.each(['resolve','reject'])('NEW pending ACK %s after pin never reads changed live Job identity',async kind=>{
 const {state,jobs}=fixture();let resolve!:(v:any)=>void,reject!:(e:any)=>void,reads=0;const p=new Promise<any>((r,j)=>{resolve=r;reject=j;});const raw={original:'raw'};let job:any;let originalId='';jobs.attachUpstream(upstream(()=>p));
 try{job=jobs.start(input(),async()=>result);originalId=job.jobId;await job.promise;Object.defineProperty(job,'jobId',{enumerable:true,configurable:true,get(){reads++;return 'changed-untrusted';}});jobs.pinNonforcingShutdown();if(kind==='resolve')resolve(raw);else reject(raw);await Promise.resolve();record('late-ack-'+kind,{reads,retained:(jobs as any).executionAcknowledgements.get(job)?.value===p,originalObservation:(jobs as any).nonforcingLateObservations.get(originalId)?.some((r:any)=>r.value===raw),resource:jobs.observeNonforcingExit()});expect(reads).toBe(0);expect((jobs as any).nonforcingLateObservations.get(originalId)).toContainEqual({kind:'execution-ack-error',value:raw});}finally{if(job)Object.defineProperty(job,'jobId',{value:originalId,writable:true,enumerable:true,configurable:true});state.close();}
});
test.each(['normal','upstream-error'])('NEW completion %s own Job accessor pin stops subsequent spread getters',async kind=>{
 const {state,jobs}=fixture();let afterPin=0,versionReads=0;let job:any;const returned:any=kind==='normal'?result:{...result,isError:true};
 try{job=jobs.start(input(),async()=>returned,(_r,current)=>{Object.defineProperty(current,'version',{enumerable:true,configurable:true,get(){versionReads++;jobs.pinNonforcingShutdown();return 1;}});Object.defineProperty(current,'adversarialTail',{enumerable:true,configurable:true,get(){afterPin++;return 'late';}});});await job.promise;record('job-spread-'+kind,{versionReads,afterPin,status:job.status,sql:state.listJobs()[0].status,resource:jobs.observeNonforcingExit()});expect(afterPin).toBe(0);}finally{if(job){Object.defineProperty(job,'version',{value:1,writable:true,enumerable:true,configurable:true});delete job.adversarialTail;}state.close();}
});
test('NEW completion callback mutation cannot replace original Job owner identity',async()=>{
 const {state,jobs}=fixture();let originalId='',job:any;const changed='changed-'+randomUUID();
 try{job=jobs.start(input(),async()=>result,(_r,current)=>{current.jobId=changed;});originalId=[...(jobs as any).jobs.keys()][0];await job.promise;jobs.pinNonforcingShutdown();const sql=state.listJobs().map((j:any)=>({id:j.jobId,status:j.status}));record('job-id-mutation',{originalId,currentId:job.jobId,status:job.status,sql,originalMapSame:(jobs as any).jobs.get(originalId)===job,originalSettlement:(jobs as any).deferredSettlements.get(originalId)?.kind,resource:jobs.observeNonforcingExit()});expect(job.jobId).toBe(originalId);expect(state.listJobs().some((j:any)=>j.jobId===changed)).toBe(false);}finally{state.close();}
});
test('NEW application cleanup throw preserves every later original cleanup capability',()=>{
 const {state,jobs,settings,catalog,registered}=application();const original=new Error('first-cleanup-original');let laterCalls=0;const later=()=>{laterCalls++;};settings.subscribeChanges=()=>()=>{throw original;};catalog.subscribe=()=>later;const unsubscribe=registered.applicationService.subscribeChanges!(()=>{});
 try{let caught:any;try{unsubscribe();}catch(e){caught=e;}const observations=[...(jobs as any).nonforcingLateObservations.values()].flat();jobs.pinNonforcingShutdown();record('cleanup-throw',{caughtOriginal:caught===original,laterCalls,laterRetained:observations.some((r:any)=>r.value===later),resource:jobs.observeNonforcingExit()});expect(caught).toBe(original);expect(laterCalls>0||observations.some((r:any)=>r.value===later)).toBe(true);}finally{registered.dispose();state.close();}
});
test.each(['false','promise','throw'])('NEW catalog application listener %s preserves exact raw outcome and receiver',async kind=>{
 const {state,jobs,catalog,registered}=application();let call!:()=>void,receiver:any='pending',release!:()=>void;const p=new Promise<void>(r=>release=r);const error=new Error('original-listener');const raw=kind==='promise'?p:false;catalog.subscribe=function(this:any,callback:()=>void){expect(this).toBe(catalog);call=callback;return ()=>{};};const listener:any=function(this:any){receiver=this;if(kind==='throw')throw error;return raw;};Object.defineProperty(listener,'call',{get(){throw Error('poisoned lookup');}});const unsub=registered.applicationService.subscribeChanges!(listener);
 try{let caught:any;try{call();}catch(e){caught=e;}expect(receiver).toBeUndefined();const obs=(jobs as any).nonforcingLateObservations.get('application-listener');expect(obs).toContainEqual({kind:kind==='throw'?'listener-error':'listener-result',value:kind==='throw'?error:raw});if(kind==='throw')expect(caught).toBe(error);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{release();await p;unsub();registered.dispose();state.close();}
});
test('NEW cleanup pin retains later capabilities without invoking them',()=>{
 const {state,jobs,settings,catalog,registered}=application();let laterCalls=0;const later=()=>{laterCalls++;};settings.subscribeChanges=()=>()=>{jobs.pinNonforcingShutdown();};catalog.subscribe=()=>later;const unsubscribe=registered.applicationService.subscribeChanges!(()=>{});
 try{unsubscribe();expect(laterCalls).toBe(0);expect((jobs as any).nonforcingLateObservations.get('application-subscription')).toContainEqual({kind:'retained-unsubscribe',value:later});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{registered.dispose();state.close();}
});
test.each(['false','throw'])('NEW unpinned cleanup %s preserves raw callback result/error',kind=>{
 const {state,jobs,settings,registered}=application();const original=new Error('original-cleanup');settings.subscribeChanges=()=>()=>{if(kind==='throw')throw original;return false;};const unsubscribe=registered.applicationService.subscribeChanges!(()=>{});
 try{let caught:any;try{unsubscribe();}catch(e){caught=e;}expect((jobs as any).nonforcingLateObservations.get('application-listener')).toContainEqual({kind:kind==='throw'?'listener-error':'listener-result',value:kind==='throw'?original:false});jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');}finally{registered.dispose();state.close();}
});
test('NEW settings first notification pin prevents second publication',()=>{
 const {state,jobs,settings,registered}=application();let call!:()=>void,calls=0;settings.subscribeChanges=(callback:any)=>{call=callback;return ()=>{};};const unsubscribe=registered.applicationService.subscribeChanges!(()=>{calls++;jobs.pinNonforcingShutdown();});
 try{call();expect(calls).toBe(1);}finally{unsubscribe();registered.dispose();state.close();}
});
test('NEW native ACK undefined fulfillment preserves ordinary terminal compatibility',async()=>{
 const {state,jobs}=fixture();const p=Promise.resolve();jobs.attachUpstream(upstream(()=>p));try{const job=jobs.start(input(),async()=>result);await job.promise;await Promise.resolve();expect((jobs as any).executionAcknowledgements.has(job)).toBe(false);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test('NEW application normal cleanup receiver and exact capability execute once',()=>{
 const {state,jobs,catalog,registered}=application();let receiver:any='pending',calls=0;const cleanup:any=function(this:any){receiver=this;calls++;};Object.defineProperty(cleanup,'call',{get(){throw Error('poisoned');}});catalog.subscribe=function(this:any){expect(this).toBe(catalog);return cleanup;};const unsubscribe=registered.applicationService.subscribeChanges!(()=>{});try{unsubscribe();expect(receiver).toBeUndefined();expect(calls).toBe(1);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{registered.dispose();state.close();}
});

test.each(['delete','replace','accessor'])('Owned completion Promise %s cannot detach the original producer',async kind=>{
 const {state,jobs}=fixture();let reads=0;
 try{
  const job=jobs.start(input(),async()=>result,(_r,current)=>{
   if(kind==='delete')delete (current as any).promise;
   else if(kind==='replace')current.promise=Promise.resolve();
   else Object.defineProperty(current,'promise',{configurable:true,enumerable:true,get(){reads++;return Promise.resolve();}});
  });
  const original=job.promise,id=job.jobId;await original;
  expect(reads).toBe(0);expect(state.listJobs()[0].status).toBe('running');
  expect((jobs as any).deferredSettlements.get(id)?.result).toEqual(result);
  expect((jobs as any).ownedJobPromises.get(job)).toBe(original);
  jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');
 }finally{state.close();}
});

test('Assignment mutation retains raw outcome under the original admission identity',async()=>{
 const {state,jobs}=fixture();const changed='changed-'+randomUUID(),raw={assignmentFailure:true};
 try{
  const job=jobs.start(input(),async(_progress,assigned)=>{
   assigned({backendKind:'app-server',workerId:'worker',workerGeneration:1,upstreamRequestId:'assignment-request',threadId:'thread'});return result;
  },undefined,undefined,false,(_assignment,current)=>{current.jobId=changed;throw raw;});
  const id=[...(jobs as any).jobs.keys()][0];await job.promise;
  expect((jobs as any).jobs.get(id)).toBe(job);
  expect((jobs as any).nonforcingLateObservations.get(id)).toContainEqual({kind:'assignment-callback-error',value:raw});
  expect((jobs as any).deferredSettlements.get(id)?.result).toEqual(result);
  expect(state.listJobs().some(j=>j.jobId===changed)).toBe(false);
  jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');
 }finally{state.close();}
});
