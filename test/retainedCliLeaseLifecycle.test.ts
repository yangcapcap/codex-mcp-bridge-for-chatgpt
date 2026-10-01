import {test,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({acquire:vi.fn(),guard:vi.fn(async()=>{}),pool:vi.fn(),start:vi.fn()}));
vi.mock('../src/codexRuntime.js',async importOriginal=>({...await importOriginal<object>(),CodexRuntimeManager:class {}}));
vi.mock('../src/codexService.js',()=>({CodexService:class {acquireContext=mocks.acquire;admissionGuard(){return mocks.guard;}setAccountReader(){}setAuthPolicyReader(){}cacheRevision(){return 'private';}}}));
vi.mock('../src/appServerUpstream.js',()=>({CodexAppServerUpstreamPool:mocks.pool}));
vi.mock('../src/executionServiceProcess.js',()=>({ChildProcessCodexExecutionService:{start:mocks.start}}));
vi.mock('../src/executionTransport.js',()=>({executionEndpoint:()=>'/private-review'}));
import {createExecutionRuntime} from '../src/executionRuntime.js';
import {shutdownResult} from '../src/shutdown.js';
const policy={allowSigkillEscalation:false as const,graceMs:0};
const d=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const make=(isolated=false)=>createExecutionRuntime({codexCommand:'fixture',upstreamPoolSize:1,stateDatabaseFile:'/private-review'} as any,{}, {HOME:'/private-review',PATH:''},{isolateCodexExecution:isolated});
beforeEach(()=>{vi.clearAllMocks();});
test.each([false,true])('late CLI resolution cannot construct pool or owner: isolated %s',async isolated=>{const context=d<any>(),release=vi.fn(async()=>{});mocks.acquire.mockReturnValue(context.promise);const r=make(isolated),request=r.prepareExecution({backendKind:'app-server',contextMode:'fresh'}).catch(e=>e);await Promise.resolve();expect(mocks.acquire).toHaveBeenCalledTimes(1);const close=r.closeNonforcing(policy);context.resolve({selection:{command:'/fixture'},release});expect((await request).message).toContain('CONSTRUCTION_CLOSED');expect((await close).outcome).toBe('uncertain');expect(mocks.pool).not.toHaveBeenCalled();expect(mocks.start).not.toHaveBeenCalled();await expect(r.close()).rejects.toThrow('UNCONFIRMED');expect(release).not.toHaveBeenCalled();});
test('ordinary router allSettled preserves established pool-failure behavior',async()=>{const release=vi.fn(async()=>{}),b={prepareExecution:vi.fn(async()=>{}),close:vi.fn(async()=>{throw Error('lower-failed');})};mocks.acquire.mockResolvedValue({selection:{command:'/fixture'},release});mocks.pool.mockImplementation(function(){return b;});const r=make();await r.prepareExecution({backendKind:'app-server',contextMode:'fresh'});await r.close();expect(b.close).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);});
test('successful ordinary close still releases acquired context',async()=>{const release=vi.fn(async()=>{}),b={prepareExecution:vi.fn(async()=>{}),close:vi.fn(async()=>{})};mocks.acquire.mockResolvedValue({selection:{command:'/fixture'},release});mocks.pool.mockImplementation(function(){return b;});const r=make();await r.prepareExecution({backendKind:'app-server',contextMode:'fresh'});await r.close();expect(b.close).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledTimes(1);});
test('acquired CLI context keeps UNKNOWN even through fresh lower positive observation',async()=>{const release=vi.fn(async()=>{}),b={prepareExecution:vi.fn(async()=>{}),close:vi.fn(async()=>{}),closeNonforcing:vi.fn(()=>Promise.resolve(shutdownResult('timeout',1))),observeNonforcingExit:vi.fn(()=>Promise.resolve(shutdownResult('exited')))};mocks.acquire.mockResolvedValue({selection:{command:'/fixture'},release});mocks.pool.mockImplementation(function(){return b;});const r=make();await r.prepareExecution({backendKind:'app-server',contextMode:'fresh'});const receipt=await r.closeNonforcing(policy);expect(receipt.outcome).toBe('uncertain');expect((await r.observeNonforcingExit()).outcome).toBe('uncertain');await expect(r.close()).rejects.toThrow('UNCONFIRMED');expect(release).not.toHaveBeenCalled();expect(b.close).not.toHaveBeenCalled();});

import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
async function actualLease(){const actual=await vi.importActual<typeof import('../src/codexRuntime.js')>('../src/codexRuntime.js'),root=await mkdtemp(join(tmpdir(),'cli-lifecycle-'));
 const manager=new actual.CodexRuntimeManager({root,environment:{},discoverExternal:false}),release=await manager.lease({id:'fixture',source:'terminal',command:'/fixture',physicalPath:'/fixture',version:'0.153.4'});
 const file=join(root,'leases',(await readdir(join(root,'leases')))[0]);return {root,release,file};}
const idleBackend=()=>({prepareExecution:vi.fn(async()=>{}),close:vi.fn(async()=>{}),closeNonforcing:vi.fn(()=>Promise.resolve(shutdownResult('exited'))),observeNonforcingExit:vi.fn(()=>Promise.resolve(shutdownResult('exited')))});
test('original passive CLI lease can stay unchanged after all lower actors exit without release',async()=>{
 const f=await actualLease();try{const bytes=await readFile(f.file),b=idleBackend();mocks.acquire.mockResolvedValue({selection:{command:'/fixture'},release:f.release});mocks.pool.mockImplementation(function(){return b;});
 const r=make();await r.prepareExecution({backendKind:'app-server',contextMode:'fresh'});const initial=await r.closeNonforcing(policy),snapshot=JSON.stringify(initial);
 expect(initial.exited).toBe(true);expect((await r.observeNonforcingExit()).exited).toBe(true);await r.close();expect(b.close).not.toHaveBeenCalled();
 expect(await readFile(f.file)).toEqual(bytes);expect(JSON.stringify(initial)).toBe(snapshot);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('new lease uncertainty defeats cached EXIT and keeps initial receipt immutable',async()=>{
 const f=await actualLease();try{const b=idleBackend();mocks.acquire.mockResolvedValue({selection:{command:'/fixture'},release:f.release});mocks.pool.mockImplementation(function(){return b;});
 const r=make();await r.prepareExecution({backendKind:'app-server',contextMode:'fresh'});const initial=await r.closeNonforcing(policy),snapshot=JSON.stringify(initial);expect(initial.exited).toBe(true);
 await writeFile(f.file,'{}');expect((await r.observeNonforcingExit()).outcome).toBe('uncertain');await expect(r.close()).rejects.toThrow('UNCONFIRMED');expect(JSON.stringify(initial)).toBe(snapshot);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('late context getters never execute after pin and cannot release their original lease',async()=>{
 const pending=d<any>(),release=vi.fn(async()=>{});let reads=0;mocks.acquire.mockReturnValue(pending.promise);const r=make(),request=r.prepareExecution({backendKind:'app-server',contextMode:'fresh'}).catch(e=>e);await Promise.resolve();
 const close=r.closeNonforcing(policy);pending.resolve({get selection(){reads++;return {command:'/fixture'};},get release(){reads++;return release;}});
 await request;expect(reads).toBe(0);expect((await close).outcome).toBe('uncertain');expect((await r.observeNonforcingExit()).outcome).toBe('uncertain');expect(release).not.toHaveBeenCalled();
});
test('unsupported context field accessor fails closed without executing its getter',async()=>{
 let reads=0;mocks.acquire.mockResolvedValue({get selection(){reads++;return {command:'/fixture'};},release:vi.fn(async()=>{})});const r=make();
 await expect(r.prepareExecution({backendKind:'app-server',contextMode:'fresh'})).rejects.toThrow('OWNER_UNCONFIRMED');expect(reads).toBe(0);
 expect((await r.closeNonforcing(policy)).outcome).toBe('uncertain');expect(mocks.pool).not.toHaveBeenCalled();
});
