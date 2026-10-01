import {test,expect,vi,afterEach} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {OwnedProcessShutdown} from '../src/ownedProcessShutdown.js';
import {shutdownResult} from '../src/shutdown.js';
const spawnMock=vi.hoisted(()=>vi.fn());
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

test('parent seals admission and exact owned handle before private close, preserving idempotence',async()=>{
 const f=fixture(),first=f.controller.closeNonforcing(policy);expect(f.controller.nonforcingShutdownPinned).toBe(true);
 expect(f.controller.closeNonforcing(policy)).toBe(first);expect((await first).exited).toBe(true);
 await expect(f.controller.rpc('getDashboard',[])).rejects.toThrow('PINNED');expect(f.child.kill).not.toHaveBeenCalled();
 expect(f.child.send.mock.calls.map(c=>c[0].type)).toEqual(['close-nonforcing','finalize-nonforcing']);
 expect((await f.controller.observeNonforcingExit()).exited).toBe(true);
});

test('post-pin messages retain exact raw source without getters or settlement callbacks',async()=>{
 const f=fixture(),resolve=vi.fn(),reject=vi.fn();f.controller.pending.set('request',{resolve,reject});f.controller.abandoned.add('abandoned');
 let reads=0;const raw=Object.defineProperty({},'type',{get(){reads++;return 'rpc-response';}});
 expect((await f.controller.closeNonforcing(policy)).outcome).toBe('uncertain');
 f.controller.onMessage(raw);f.controller.onExit(f.child,new Error('late exit'));
 expect(reads).toBe(0);expect(resolve).not.toHaveBeenCalled();expect(reject).not.toHaveBeenCalled();
 expect(f.controller.pending.has('request')).toBe(true);expect(f.controller.abandoned.has('abandoned')).toBe(true);
 expect(f.controller.retainedNonforcingMessages).toContain(raw);expect(f.controller.child).toBe(f.child);
 expect(f.controller.generation).toBe(f.generation);expect(f.controller.restartTimer).toBeUndefined();
});

test('RPC timeout after pin cannot reject or move original pending capability',async()=>{
 vi.useFakeTimers();const f=fixture();let settled=false;void f.controller.rpc('getDashboard',[]).then(()=>settled=true,()=>settled=true);
 const id=f.child.send.mock.calls[0][0].requestId;expect(f.controller.pending.has(id)).toBe(true);
 await f.controller.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(100);
 expect(settled).toBe(false);expect(f.controller.pending.has(id)).toBe(true);expect(f.controller.abandoned.has(id)).toBe(false);
 expect((await f.controller.observeNonforcingExit()).outcome).toBe('uncertain');
});

test('restart and stable timers cannot spawn or reset state after pin',async()=>{
 vi.useFakeTimers();const f=fixture();f.controller.restartAttempts=9;f.controller.scheduleRestart();expect(f.controller.restartTimer).toBeDefined();
 await f.controller.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(60000);
 expect(spawnMock).not.toHaveBeenCalled();expect(f.controller.restartAttempts).toBe(10);expect(f.child.kill).not.toHaveBeenCalled();
});

test('ordinary close already in progress cannot escalate its owned handle after nonforcing pin',async()=>{
 vi.useFakeTimers();const f=fixture();const ordinary=f.controller.close();
 expect(f.child.send.mock.calls[0][0].type).toBe('close');expect((await f.controller.closeNonforcing(policy)).outcome).toBe('uncertain');
 await vi.advanceTimersByTimeAsync(6000);expect(f.child.kill).not.toHaveBeenCalled();
 f.child.emit('exit',0,null);await ordinary;
});

test('spawn hook pin prevents later pipe connection and startup timeout escalation',async()=>{
 vi.useFakeTimers();let f:any;f=fixture(()=>{void f.controller.closeNonforcing(policy);});spawnMock.mockReturnValue(f.child);
 const started=f.controller.spawnAndWait();await expect(started).rejects.toThrow('STARTUP_NONFORCING_PINNED');
 expect((f.input as any)._readableState.pipes.length).toBe(0);
 expect(f.controller.startupTimer).toBeUndefined();await vi.advanceTimersByTimeAsync(25000);expect(f.child.kill).not.toHaveBeenCalled();
 const env=spawnMock.mock.calls[0][2].env;
 expect(env.CODEX_MCP_BRIDGE_PRIVATE_RUNTIME_CONTROLLER).toBe(f.controller.controllerId);
 expect(env.CODEX_MCP_BRIDGE_PRIVATE_RUNTIME_GENERATION).toBe(f.controller.spawnGeneration);
});
