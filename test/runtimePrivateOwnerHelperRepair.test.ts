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
test('oversize early rejection stops after a response header callback pins',async()=>{const f=fixture();f.controller.port=12345;const {incoming,outgoing}=incomingAndOutgoing();incoming.headers={'content-length':'100000000'};let close:Promise<any>|undefined;outgoing.setHeader.mockImplementation(()=>{close=f.controller.closeNonforcing(policy);});f.controller.proxy(incoming,outgoing);expect(outgoing.end).not.toHaveBeenCalled();expect(outgoing.setHeader).toHaveBeenCalledTimes(1);expect(httpMock).not.toHaveBeenCalled();await close;incoming.destroy();});
test('unavailable POST body capture stays owned and does not settle after pin',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=undefined;f.controller.proxy(incoming,outgoing);const raw=Buffer.from('{"id":7}');const close=f.controller.closeNonforcing(policy);incoming.emit('data',raw);incoming.emit('end');expect(outgoing.end).not.toHaveBeenCalled();expect(f.controller.retainedNonforcingMessages.some((v:any)=>v===raw)).toBe(true);expect((await close).outcome).toBe('uncertain');incoming.destroy();});
test('classification cleanup raw exception cannot release original bytes or dispatch',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;incoming.headers={};const proxy:any=new PassThrough();proxy.setTimeout=vi.fn();httpMock.mockReturnValue(proxy);f.controller.proxy(incoming,outgoing);incoming.emit('data',Buffer.from('{"jsonrpc":"2.0","id":7,"method":"tools/list"}'));const edge=[...f.controller.proxyEdges][0],bytes=f.controller.activeProxyBytes,raw=Object.freeze({reason:'off failure'});incoming.off=vi.fn(()=>{throw raw;});incoming.emit('end');expect(httpMock).not.toHaveBeenCalled();expect(f.controller.proxyEdges.has(edge)).toBe(true);expect(f.controller.activeProxyBytes).toBe(bytes);expect(f.controller.retainedNonforcingMessages.some((v:any)=>v===raw)).toBe(true);expect((await f.controller.closeNonforcing(policy)).outcome).toBe('uncertain');incoming.destroy();proxy.destroy();});
test('unavailable response retry header callback pin prevents subsequent content headers and end',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=undefined;incoming.method='GET';let close:Promise<any>|undefined;outgoing.setHeader.mockImplementation(()=>{close=f.controller.closeNonforcing(policy);});f.controller.proxy(incoming,outgoing);expect(outgoing.setHeader).toHaveBeenCalledTimes(1);expect(outgoing.end).not.toHaveBeenCalled();await close;incoming.destroy();});
test('original proxy method callback exception retains exact method receiver args',async()=>{const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;const proxy:any=new PassThrough(),raw=Object.freeze({reason:'timeout setup'}),method=vi.fn(()=>{throw raw;});proxy.setTimeout=method;httpMock.mockReturnValue(proxy);f.controller.proxy(incoming,outgoing);expect(f.controller.retainedNonforcingMessages.some((v:any)=>v?.owner===proxy&&v?.key==='setTimeout'&&v?.method===method&&v?.error===raw&&v?.args[0]===120000)).toBe(true);expect(incoming._readableState.pipes).toEqual([]);expect((await f.controller.closeNonforcing(policy)).outcome).toBe('uncertain');incoming.destroy();proxy.destroy();});

test('ordinary unavailable POST preserves request id and retires its capture only after response',async()=>{
 const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.proxy(incoming,outgoing);
 expect(f.controller.rejectedProxyRequests).toBe(1);
 incoming.emit('data',Buffer.from('{"jsonrpc":"2.0","id":41,"method":"tools/list"}'));incoming.emit('end');
 expect(outgoing.end).toHaveBeenCalledTimes(1);expect(JSON.parse(outgoing.end.mock.calls[0][0]).id).toBe(41);
 expect(f.controller.rejectedProxyRequests).toBe(0);expect(f.controller.proxyEdges.size).toBe(0);
 await Promise.resolve();expect((await f.controller.closeNonforcing(policy)).outcome).toBe('exited');incoming.destroy();
});
test('ordinary oversize rejection completes its response without spawning a proxy',async()=>{
 const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.port=12345;incoming.headers={'content-length':'100000000'};
 f.controller.proxy(incoming,outgoing);expect(outgoing.statusCode).toBe(413);expect(outgoing.setHeader).toHaveBeenCalledTimes(2);
 expect(outgoing.end).toHaveBeenCalledTimes(1);expect(httpMock).not.toHaveBeenCalled();expect(f.controller.outstanding).toBe(0);
 await Promise.resolve();expect((await f.controller.closeNonforcing(policy)).outcome).toBe('exited');incoming.destroy();
});
test('unavailable POST cleanup exception retains original capture and prevents response',async()=>{
 const f=fixture(),{incoming,outgoing}=incomingAndOutgoing();f.controller.proxy(incoming,outgoing);
 incoming.emit('data',Buffer.from('{"id":41}'));const edge=[...f.controller.proxyEdges][0],raw=Object.freeze({reason:'rejection cleanup'});
 incoming.off=vi.fn(()=>{throw raw;});incoming.emit('end');expect(outgoing.end).not.toHaveBeenCalled();
 expect(f.controller.proxyEdges.has(edge)).toBe(true);expect(f.controller.rejectedProxyRequests).toBe(1);
 expect(f.controller.retainedNonforcingMessages.some((v:any)=>v===raw)).toBe(true);
 expect((await f.controller.closeNonforcing(policy)).outcome).toBe('uncertain');incoming.destroy();
});
