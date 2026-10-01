import {test,expect,vi} from 'vitest';import {randomUUID} from 'node:crypto';import {appendFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {CodexJobRegistry} from '../src/tools.js';import {BridgeStateStore} from '../src/stateStore.js';import {snapshotNonforcingData} from '../src/nonforcingData.js';
const result:any={content:[{type:'text',text:'retained-original'}],structuredContent:{threadId:'review-thread'}};
function input(){return {operation:'start' as const,cwd:process.cwd(),sandbox:'read-only' as const,scopeId:randomUUID(),requestId:randomUUID(),requestHash:'a'.repeat(64),requestHashVersion:2 as const,exclusiveKeys:[],sessionDecision:{requestedMode:'new' as const,action:'start' as const,reason:'explicit-new' as const}};}
function record(_label:string,_data:unknown){}
function fixture(options:any={}){const state=new BridgeStateStore({file:':memory:'});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()],...options});return {state,jobs};}
function upstream(ack:any=vi.fn()){return {listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack};}
import {registerBridgeTools} from '../src/tools.js';import {loadConfig} from '../src/config.js';import {SessionRegistry} from '../src/sessionRegistry.js';import {UserSettingsStore} from '../src/userSettings.js';import {ScopeResolver} from '../src/scopeResolver.js';

function application(){const f=fixture({projectionOnly:true});const config=loadConfig({HOME:process.env.HOME,CODEX_MCP_BRIDGE_NO_AUTH:'1',CODEX_MCP_BRIDGE_ROOTS:process.cwd(),CODEX_MCP_BRIDGE_CODEX:'/usr/bin/false',CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:join(process.env.HOME!,'not-opened.sqlite')});const settings=new UserSettingsStore(config,{stateStore:f.state});const sessions=new SessionRegistry({stateStore:f.state,allowedRoots:[process.cwd()]});const resolver=new ScopeResolver({stateStore:f.state});const catalog:any={getCatalog:async()=>({models:[],source:'fixture',fetchedAt:new Date().toISOString(),fingerprint:'a'.repeat(64),cached:false,stale:false,validation:'valid'})};const server:any={registerResource:()=>({}),registerTool:()=>({})};const u:any=upstream();const registered=registerBridgeTools(server,config,u,sessions,f.jobs,catalog,settings,resolver);return {...f,settings,catalog,registered,u};}






test('NEW before-boundary entry replacement must latch exact original producer owner',async()=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream(upstream(ack));let finish:any,calls=0,launched=0;const producer=new Promise<any>(r=>finish=r);try{const job=jobs.start(input(),async()=>{launched++;return producer;});const id=job.jobId,p=job.promise;await Promise.resolve();expect(launched).toBe(1);const replacement={...job};(jobs as any).jobs.set(id,replacement);expect(()=>jobs.publishApplicationChange(()=>{calls++;})).toThrow();finish(result);await p;jobs.pinNonforcingShutdown();record('pre-entry-replace',{calls,launched,originalUnknown:(jobs as any).unconfirmedJobCallbacks.has(job),replacementUnknown:(jobs as any).unconfirmedJobCallbacks.has(replacement),ackCalls:ack.mock.calls.length,originalRetained:(jobs as any).deferredSettlements.get(id)?.result===result,liveStatus:job.status,sqlStatus:state.listJobs()[0].status,resource:jobs.observeNonforcingExit()});expect(calls).toBe(0);expect(ack).not.toHaveBeenCalled();expect((jobs as any).unconfirmedJobCallbacks.has(job)).toBe(true);expect((jobs as any).deferredSettlements.get(id)?.result).toBe(result);}finally{finish?.(result);state.close();}
});
test('NEW before-boundary entry deletion cannot hide original running producer as EXIT',async()=>{
 const {state,jobs}=fixture();jobs.attachUpstream(upstream());let finish:any,calls=0,launched=0;const producer=new Promise<any>(r=>finish=r);let p:any;try{const job=jobs.start(input(),async()=>{launched++;return producer;});const id=job.jobId;p=job.promise;await Promise.resolve();expect(launched).toBe(1);(jobs as any).jobs.delete(id);let error:any;try{jobs.publishApplicationChange(()=>{calls++;});}catch(e){error=e;}jobs.pinNonforcingShutdown();record('pre-entry-delete',{calls,launched,threw:!!error,originalUnknown:(jobs as any).unconfirmedJobCallbacks.has(job),liveStatus:job.status,sqlStatus:state.listJobs()[0].status,resource:jobs.observeNonforcingExit()});expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect((jobs as any).unconfirmedJobCallbacks.has(job)).toBe(true);}finally{finish?.(result);await p;state.close();}
});

for(const kind of ['delete','replace','foreign-key'])test('direct '+kind+' before pin preserves original admission even without observer',async()=>{
 const {state,jobs}=fixture(),ack=vi.fn();jobs.attachUpstream(upstream(ack));let finish:any,launched=0;const producer=new Promise<any>(r=>finish=r);
 const job=jobs.start(input(),async()=>{launched++;return producer;}),id=job.jobId;
 try{await Promise.resolve();expect(launched).toBe(1);const map=(jobs as any).jobs;map.delete(id);
 if(kind==='replace')map.set(id,{...job});if(kind==='foreign-key')map.set('foreign-'+id,job);
 jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');expect(job.jobId).toBe(id);
 expect((jobs as any).unconfirmedJobCallbacks.has(job)).toBe(true);finish(result);await job.promise;expect(ack).not.toHaveBeenCalled();
 expect((jobs as any).deferredSettlements.get(id)?.result).toBe(result);expect(state.listJobs()[0].jobId).toBe(id);
 }finally{finish(result);await job.promise;state.close();}
});
test('index deletion before producer rejection retains original raw failure without observer',async()=>{
 const {state,jobs}=fixture(),ack=vi.fn();jobs.attachUpstream(upstream(ack));let reject:any;const raw={original:'producer-error'};
 const producer=new Promise<any>((_r,r)=>reject=r),job=jobs.start(input(),async()=>producer),id=job.jobId;
 try{await Promise.resolve();(jobs as any).jobs.delete(id);reject(raw);await job.promise;expect(ack).not.toHaveBeenCalled();
 expect((jobs as any).deferredSettlements.get(id)?.error).toBe(raw);jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe('uncertain');
 }finally{reject(raw);await job.promise;state.close();}
});
test('authorized terminal index removal remains ordinary and does not invent uncertainty',async()=>{
 const {state,jobs}=fixture(),ack=vi.fn();jobs.attachUpstream(upstream(ack));try{
 const job=jobs.start(input(),async()=>result);await job.promise;expect(ack).toHaveBeenCalledOnce();
 (jobs as any).deleteIndexedJob(job.jobId);expect((jobs as any).jobs.has(job.jobId)).toBe(false);
 jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().exited).toBe(true);
 }finally{state.close();}
});
