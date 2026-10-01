import {test,expect,vi,afterEach} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {OwnedProcessShutdown} from '../src/ownedProcessShutdown.js';
import {shutdownResult} from '../src/shutdown.js';
const spawnMock=vi.hoisted(()=>vi.fn());
const httpMock=vi.hoisted(()=>vi.fn());
vi.mock('node:http',async importOriginal=>({...await importOriginal<object>(),request:httpMock}));
vi.mock('node:child_process',async importOriginal=>({...await importOriginal<object>(),spawn:spawnMock}));
import {IsolatedRuntimeController} from '../src/runtimeProcess.js';
const policy={allowSigkillEscalation:false,graceMs:0} as const;
function fixture(onSpawn?:()=>void){
 const input=new PassThrough(),output=new PassThrough(),controller:any=new (IsolatedRuntimeController as any)('stdio',{NODE_ENV:'test',CODEX_MCP_BRIDGE_TEST_RPC_OBSERVATION_TIMEOUT_MS:'50'},false,input,output,onSpawn);
 const child:any=new EventEmitter();Object.assign(child,{pid:980103,connected:true,exitCode:null,signalCode:null,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(),send:vi.fn()});
 const generation=randomUUID(),controllerId=randomUUID();
 controller.child=child;controller.generation=generation;controller.spawnGeneration=generation;controller.controllerId=controllerId;
 child.send.mockImplementation((request:any,done:any)=>{done?.();if(!request.type.endsWith('nonforcing'))return true;queueMicrotask(()=>{
  const {policy,type,...binding}=request;child.emit('message',{...binding,type:'shutdown-receipt',operation:type,result:shutdownResult('exited')});
  if(type==='finalize-nonforcing')child.exitCode=0;
 });return false;});
 controller.shutdown=new OwnedProcessShutdown(child,{generation:()=>generation,pin:()=>controller.freezeNonforcing()},controllerId);
 return {controller,child,input,output,generation,controllerId};
}
afterEach(()=>{vi.clearAllMocks();vi.useRealTimers();});

test('runtime ordinary close cannot report success after observed owned PID identity uncertainty',async()=>{const f=fixture();const original=await f.controller.closeNonforcing(policy);expect(original.exited).toBe(true);const pid=f.child.pid;f.child.pid=pid+1;expect((await f.controller.observeNonforcingExit()).outcome).toBe('uncertain');f.child.pid=pid;await expect(f.controller.close()).rejects.toThrow('UNCONFIRMED');expect(original.exited).toBe(true);expect(f.child.kill).not.toHaveBeenCalled();});
test('runtime owner response receiver and raw send-error retention stay original after pin',async()=>{const f=fixture();let callback:any;f.child.send.mockImplementation((m:any,cb:any)=>{if(m.type==='rpc')callback=cb;return true;});const req=f.controller.rpc('runtimeSnapshot',[]);req.catch(()=>{});const pending=[...f.controller.pending.values()][0];vi.useFakeTimers();const close=f.controller.closeNonforcing(policy);let reads=0;const raw=Object.defineProperty({},'message',{get(){reads++;return 'must not read';}});callback(raw);expect(reads).toBe(0);expect(f.controller.retainedNonforcingMessages.some((v:any)=>v===raw)).toBe(true);expect([...f.controller.pending.values()][0]).toBe(pending);await vi.advanceTimersByTimeAsync(20000);expect((await close).outcome).toBe('uncertain');expect(f.child.kill).not.toHaveBeenCalled();});
test('ready message with wrong controller or spawn generation cannot become current identity',async()=>{const f=fixture();f.controller.generation=undefined;const rejected=vi.fn();f.controller.startupReject=rejected;const health={acceptingNewJobs:true,backgroundProcessState:'confirmed',pendingAdmissions:0,activeJobs:0};f.controller.onMessage({type:'ready',protocol:'bridge-operational-state-owner',protocolVersion:3,transport:'stdio',controllerId:randomUUID(),generation:f.generation,heartbeatAt:Date.now(),runtimeHealth:health});expect(f.controller.generation).toBeUndefined();expect(f.controller.controllerId).toBe(f.controllerId);expect(rejected).toHaveBeenCalledOnce();});
function proxyFixture(){const f=fixture();f.controller.port=12345;const incoming:any=new PassThrough();Object.assign(incoming,{headers:{'content-length':'100'},method:'POST',url:'/mcp'});const outgoing:any=new EventEmitter();Object.assign(outgoing,{headersSent:false,destroyed:false,writableEnded:false,setHeader:vi.fn(),writeHead:vi.fn(),end:vi.fn(),destroy:vi.fn()});const proxy:any=new PassThrough();proxy.setTimeout=vi.fn();const wrote=vi.fn();proxy.on('data',wrote);httpMock.mockReturnValue(proxy);f.controller.proxy(incoming,outgoing);return {...f,incoming,outgoing,proxy,wrote};}
test('parent pin stops further body forwarding on an already opened proxy',async()=>{const f=proxyFixture();const close=f.controller.closeNonforcing(policy);f.incoming.write(Buffer.from('late-body'));await Promise.resolve();expect(f.wrote).not.toHaveBeenCalled();expect((await close).outcome).toBe('uncertain');f.incoming.destroy();f.proxy.destroy();});
test('post-pin proxy error preserves original accounting and raw error without settlement',async()=>{const f=proxyFixture(),requests=f.controller.activeProxyRequests,bytes=f.controller.activeProxyBytes;const close=f.controller.closeNonforcing(policy);const raw=new Error('late proxy failure');f.proxy.emit('error',raw);expect(f.controller.activeProxyRequests).toBe(requests);expect(f.controller.activeProxyBytes).toBe(bytes);expect(f.controller.retainedNonforcingMessages.some((v:any)=>v===raw)).toBe(true);expect(f.outgoing.end).not.toHaveBeenCalled();await close;f.incoming.destroy();f.proxy.destroy();});

test('fresh ordinary close measures changed owned PID even without a previous observation',async()=>{
 const f=fixture();const initial=await f.controller.closeNonforcing(policy);expect(initial.exited).toBe(true);f.child.pid++;
 await expect(f.controller.close()).rejects.toThrow('UNCONFIRMED');expect(initial.exited).toBe(true);expect(f.child.kill).not.toHaveBeenCalled();
});
test('late proxy response retains exact stream and does not write or forward headers',async()=>{
 const f=proxyFixture(),response:any=new PassThrough();response.statusCode=200;response.headers={};const callback=httpMock.mock.calls.at(-1)![1];
 const close=f.controller.closeNonforcing(policy);callback(response);expect(f.outgoing.writeHead).not.toHaveBeenCalled();expect(f.controller.retainedNonforcingMessages).toContain(response);
 expect((response as any)._readableState.pipes).toEqual([]);expect((await close).outcome).toBe('uncertain');f.incoming.destroy();f.proxy.destroy();response.destroy();
});
test('late proxy finish and timeout preserve original capture and counters',async()=>{
 const f=proxyFixture(),edge=[...f.controller.proxyEdges][0],requests=f.controller.activeProxyRequests,bytes=f.controller.activeProxyBytes;
 const close=f.controller.closeNonforcing(policy);f.proxy.emit('finish');f.proxy.setTimeout.mock.calls[0][1]();
 expect(f.controller.proxyEdges.has(edge)).toBe(true);expect(f.controller.activeProxyRequests).toBe(requests);expect(f.controller.activeProxyBytes).toBe(bytes);
 expect(f.outgoing.end).not.toHaveBeenCalled();expect(f.proxy.destroyed).toBe(false);await close;f.incoming.destroy();f.proxy.destroy();
});
test('pin during request classification retains original slot, bytes and capture without dispatch',async()=>{
 vi.useFakeTimers();const f=fixture();f.controller.port=12345;const incoming:any=new PassThrough();Object.assign(incoming,{headers:{},method:'POST',url:'/mcp'});
 const outgoing:any=new EventEmitter();Object.assign(outgoing,{headersSent:false,destroyed:false,writableEnded:false,setHeader:vi.fn(),writeHead:vi.fn(),end:vi.fn(),destroy:vi.fn()});
 f.controller.proxy(incoming,outgoing);incoming.write(Buffer.from('{"id":7'));const requests=f.controller.activeProxyRequests,bytes=f.controller.activeProxyBytes,edge=[...f.controller.proxyEdges][0];
 const close=f.controller.closeNonforcing(policy);incoming.emit('end');outgoing.emit('close');await vi.advanceTimersByTimeAsync(20000);await close;
 expect(httpMock).not.toHaveBeenCalled();expect(f.controller.proxyEdges.has(edge)).toBe(true);expect(f.controller.activeProxyRequests).toBe(requests);expect(f.controller.activeProxyBytes).toBe(bytes);
 expect(outgoing.end).not.toHaveBeenCalled();expect(f.child.kill).not.toHaveBeenCalled();incoming.destroy();
});
