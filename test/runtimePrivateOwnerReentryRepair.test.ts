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


function proxyFixture(){const f=fixture();f.controller.port=12345;const incoming:any=new PassThrough();Object.assign(incoming,{headers:{'content-length':'100'},method:'POST',url:'/mcp'});const outgoing:any=new PassThrough();Object.assign(outgoing,{headersSent:false,setHeader:vi.fn(),writeHead:vi.fn()});const proxy:any=new PassThrough();proxy.setTimeout=vi.fn();const wrote=vi.fn(),received=vi.fn();proxy.on('data',wrote);outgoing.on('data',received);httpMock.mockReturnValue(proxy);f.controller.proxy(incoming,outgoing);return {...f,incoming,outgoing,proxy,wrote,received};}
test('response writeHead pin cannot establish a new response pipe after the fence',async()=>{const f=proxyFixture(),response:any=new PassThrough();response.statusCode=200;response.headers={};const callback=httpMock.mock.calls.at(-1)![1];let close:Promise<any>|undefined;f.outgoing.writeHead.mockImplementation(()=>{close=f.controller.closeNonforcing(policy);});callback(response);response.write(Buffer.from('late-response'));await Promise.resolve();expect(f.received).not.toHaveBeenCalled();expect((response as any)._readableState.pipes).toEqual([]);await close;f.incoming.destroy();f.proxy.destroy();response.destroy();f.outgoing.destroy();});
test('destination pipe event pin cannot add later response listeners that retire original capture',async()=>{const f=proxyFixture(),response:any=new PassThrough();response.statusCode=200;response.headers={};const callback=httpMock.mock.calls.at(-1)![1],edge=[...f.controller.proxyEdges][0],raw=new Error('late response error');let close:Promise<any>|undefined;f.outgoing.once('pipe',()=>{close=f.controller.closeNonforcing(policy);});callback(response);response.emit('error',raw);expect(f.controller.proxyEdges.has(edge)).toBe(true);expect(f.controller.retainedNonforcingMessages.some((x:any)=>x===raw)).toBe(true);expect(f.controller.activeProxyRequests).toBe(1);expect(f.controller.activeProxyBytes).toBe(100);await close;f.incoming.destroy();f.proxy.destroy();response.destroy();f.outgoing.destroy();});
test('setTimeout getter pin cannot proceed to input pipe installation',async()=>{const f=fixture();f.controller.port=12345;const incoming:any=new PassThrough();Object.assign(incoming,{headers:{'content-length':'100'},method:'POST',url:'/mcp'});const outgoing:any=new PassThrough();Object.assign(outgoing,{headersSent:false,setHeader:vi.fn(),writeHead:vi.fn()});const proxy:any=new PassThrough(),wrote=vi.fn();proxy.on('data',wrote);let close:Promise<any>|undefined;Object.defineProperty(proxy,'setTimeout',{get(){close=f.controller.closeNonforcing(policy);return vi.fn();}});httpMock.mockReturnValue(proxy);f.controller.proxy(incoming,outgoing);incoming.write(Buffer.from('after-getter-pin'));await Promise.resolve();expect(wrote).not.toHaveBeenCalled();expect((incoming as any)._readableState.pipes).toEqual([]);await close;incoming.destroy();proxy.destroy();outgoing.destroy();});
test('request header lookup pin prevents creation of a fresh proxy transport',async()=>{const f=fixture();f.controller.port=12345;const incoming:any=new PassThrough(),outgoing:any=new PassThrough();Object.assign(outgoing,{headersSent:false,setHeader:vi.fn(),writeHead:vi.fn()});Object.assign(incoming,{method:'POST',url:'/mcp'});let close:Promise<any>|undefined;Object.defineProperty(incoming,'headers',{get(){close=f.controller.closeNonforcing(policy);return {'content-length':'100'};}});const proxy:any=new PassThrough();proxy.setTimeout=vi.fn();httpMock.mockReturnValue(proxy);f.controller.proxy(incoming,outgoing);expect(httpMock).not.toHaveBeenCalled();expect(f.controller.activeProxyRequests).toBe(0);await close;incoming.destroy();proxy.destroy();outgoing.destroy();});
test('close fresh observation mutation before await continuation cannot reopen ordinary success',async()=>{const f=fixture();const initial=await f.controller.closeNonforcing(policy);const observe=f.controller.observeNonforcingExit.bind(f.controller);let calls=0;f.controller.observeNonforcingExit=async()=>{const result=await observe();if(++calls===1)queueMicrotask(()=>{f.child.pid++;});return result;};await expect(f.controller.close()).rejects.toThrow('UNCONFIRMED');expect(initial.exited).toBe(true);expect(f.child.kill).not.toHaveBeenCalled();});

test('nested content length getter pin stops accounting and new proxy creation',async()=>{
 const f=fixture();f.controller.port=12345;const incoming:any=new PassThrough(),outgoing:any=new PassThrough();Object.assign(incoming,{method:'POST',url:'/mcp'});const headers:any={};let close:Promise<any>|undefined;
 Object.defineProperty(headers,'content-length',{enumerable:true,get(){close=f.controller.closeNonforcing(policy);return '100';}});incoming.headers=headers;
 f.controller.proxy(incoming,outgoing);expect(httpMock).not.toHaveBeenCalled();expect(f.controller.activeProxyRequests).toBe(0);expect(f.controller.activeProxyBytes).toBe(0);await close;incoming.destroy();outgoing.destroy();
});
test('response writeHead method getter pin never invokes captured method or opens a pipe',async()=>{
 const f=proxyFixture(),response:any=new PassThrough();response.statusCode=200;response.headers={};const callback=httpMock.mock.calls.at(-1)![1],write=vi.fn();let close:Promise<any>|undefined;
 Object.defineProperty(f.outgoing,'writeHead',{get(){close=f.controller.closeNonforcing(policy);return write;}});callback(response);response.write(Buffer.from('must stay owned'));await Promise.resolve();expect(write).not.toHaveBeenCalled();expect(f.received).not.toHaveBeenCalled();expect((response as any)._readableState.pipes).toEqual([]);await close;f.incoming.destroy();f.proxy.destroy();response.destroy();f.outgoing.destroy();
});
