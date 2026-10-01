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

function incomingAndOutgoing(){const incoming:any=new PassThrough();Object.assign(incoming,{headers:{'content-length':'100'},method:'POST',url:'/mcp'});const outgoing:any=new EventEmitter();Object.assign(outgoing,{headersSent:false,destroyed:false,writableEnded:false,setHeader:vi.fn(),writeHead:vi.fn(),end:vi.fn(),destroy:vi.fn()});return {incoming,outgoing};}

test('buffered oversize capture dispose getter pin cannot invoke captured method or retire original slot',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;f.controller.activeProxyRequests=1;incoming.headers={'content-length':'100000000'};const dispose=vi.fn(),capture:any={id:vi.fn(()=>7)};let close:Promise<any>|undefined;Object.defineProperty(capture,'dispose',{get(){close=f.controller.closeNonforcing(policy);return dispose;}});f.controller.proxy(incoming,outgoing,{body:Buffer.from('{"id":7}'),capture,priority:false,ordinarySlotReserved:true});expect(dispose).not.toHaveBeenCalled();expect(f.controller.activeProxyRequests).toBe(1);expect(outgoing.end).not.toHaveBeenCalled();expect((await close).outcome).toBe('uncertain');incoming.destroy();});
test('buffered unavailable capture id getter pin cannot invoke method after lookup',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=undefined;f.controller.activeProxyRequests=1;const id=vi.fn(()=>7),capture:any={dispose:vi.fn()};let close:Promise<any>|undefined;Object.defineProperty(capture,'id',{get(){close=f.controller.closeNonforcing(policy);return id;}});f.controller.proxy(incoming,outgoing,{body:Buffer.from('{"id":7}'),capture,priority:false,ordinarySlotReserved:true});expect(id).not.toHaveBeenCalled();expect(outgoing.end).not.toHaveBeenCalled();expect((await close).outcome).toBe('uncertain');incoming.destroy();});
test('buffered capacity capture id getter pin cannot invoke method after lookup',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;f.controller.activeProxyRequests=1;f.controller.activeProxyBytes=100000000;const id=vi.fn(()=>7),capture:any={dispose:vi.fn()};let close:Promise<any>|undefined;Object.defineProperty(capture,'id',{get(){close=f.controller.closeNonforcing(policy);return id;}});f.controller.proxy(incoming,outgoing,{body:Buffer.from('{"id":7}'),capture,priority:false,ordinarySlotReserved:true});expect(id).not.toHaveBeenCalled();expect(outgoing.end).not.toHaveBeenCalled();expect((await close).outcome).toBe('uncertain');incoming.destroy();});
test('ordinary rejection id and capture retire only after successful response',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=undefined;f.controller.proxy(incoming,outgoing);const edge=[...f.controller.proxyEdges][0];incoming.emit('data',Buffer.from('{"id":42}'));incoming.emit('end');expect(outgoing.end).toHaveBeenCalledTimes(1);expect(JSON.parse(outgoing.end.mock.calls[0][0]).id).toBe(42);expect(f.controller.proxyEdges.has(edge)).toBe(false);expect(f.controller.rejectedProxyRequests).toBe(0);await Promise.resolve();expect((await f.controller.closeNonforcing(policy)).exited).toBe(true);incoming.destroy();});
test('ordinary classification transfer completes one dispatch and balances original accounting',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;incoming.headers={};const proxy:any=new PassThrough();proxy.setTimeout=vi.fn();httpMock.mockReturnValue(proxy);f.controller.proxy(incoming,outgoing);const original=[...f.controller.proxyEdges][0];incoming.emit('data',Buffer.from('{"jsonrpc":"2.0","id":42,"method":"tools/list"}'));incoming.emit('end');expect(httpMock).toHaveBeenCalledOnce();expect(f.controller.proxyEdges.has(original)).toBe(false);expect(f.controller.activeProxyRequests).toBe(1);const response:any=new PassThrough();response.statusCode=200;response.headers={};outgoing.write=vi.fn();const callback=httpMock.mock.calls[0][1];callback(response);response.emit('end');expect(f.controller.activeProxyRequests).toBe(0);expect(f.controller.activeProxyBytes).toBe(0);expect(f.controller.proxyEdges.size).toBe(0);await Promise.resolve();expect((await f.controller.closeNonforcing(policy)).exited).toBe(true);incoming.destroy();proxy.destroy();response.destroy();});
test('rejection cleanup off getter pin retains original rejection slot and stops captured method',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=undefined;f.controller.proxy(incoming,outgoing);incoming.emit('data',Buffer.from('{"id":42}'));const edge=[...f.controller.proxyEdges][0],off=vi.fn();let close:Promise<any>|undefined;Object.defineProperty(incoming,'off',{get(){close=f.controller.closeNonforcing(policy);return off;}});incoming.emit('end');expect(off).not.toHaveBeenCalled();expect(outgoing.end).not.toHaveBeenCalled();expect(f.controller.proxyEdges.has(edge)).toBe(true);expect(f.controller.rejectedProxyRequests).toBe(1);expect((await close).outcome).toBe('uncertain');incoming.destroy();});

for(const mode of ['oversize','unavailable','capacity'])test('native classification '+mode+' preserves original capture and slot after lookup pin',async()=>{
 const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;incoming.headers={};
 f.controller.proxy(incoming,outgoing);const edge=[...f.controller.proxyEdges][0],capture=edge.capture;
 const body=Buffer.from('{"jsonrpc":"2.0","id":42,"method":"tools/list"}');incoming.emit('data',body);
 const key=mode==='oversize'?'dispose':'id',originalMethod=capture[key].bind(capture),method=vi.fn(originalMethod);let close:Promise<any>|undefined;
 Object.defineProperty(capture,key,{get(){close=f.controller.closeNonforcing(policy);return method;},configurable:true});
 const originalProxy=f.controller.proxy.bind(f.controller);f.controller.proxy=(i:any,o:any,b:any)=>{
  if(mode==='oversize')incoming.headers={'content-length':'100000000'};
  if(mode==='unavailable')f.controller.port=undefined;
  if(mode==='capacity')f.controller.activeProxyBytes=100000000;
  return originalProxy(i,o,b);
 };
 incoming.emit('end');expect(method).not.toHaveBeenCalled();expect(capture.bytes).toBe(body.length);
 expect(f.controller.activeProxyRequests).toBe(1);expect(f.controller.proxyEdges.has(edge)).toBe(true);
 expect(outgoing.end).not.toHaveBeenCalled();expect(httpMock).not.toHaveBeenCalled();expect((await close).outcome).toBe('uncertain');incoming.destroy();
});
test('ordinary buffered oversize retires its slot only after response completion',async()=>{
 const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;f.controller.activeProxyRequests=1;
 incoming.headers={'content-length':'100000000'};const capture:any={dispose:vi.fn(),id:vi.fn(()=>42)};
 f.controller.proxy(incoming,outgoing,{body:Buffer.from('{"id":42}'),capture,priority:false,ordinarySlotReserved:true});
 expect(capture.dispose).toHaveBeenCalledOnce();expect(outgoing.end).toHaveBeenCalledOnce();expect(outgoing.statusCode).toBe(413);
 expect(f.controller.activeProxyRequests).toBe(0);expect(f.controller.proxyEdges.size).toBe(0);
 await Promise.resolve();expect((await f.controller.closeNonforcing(policy)).exited).toBe(true);incoming.destroy();
});
