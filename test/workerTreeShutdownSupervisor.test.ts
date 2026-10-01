import {describe,expect,test,vi} from "vitest";
import {SupervisedProcessTreeRegistry} from "../src/processTreeSupervisor.js";
import {WorkerTreeShutdownSupervisor} from "../src/workerTreeShutdownSupervisor.js";
import {snapshotWorkerShutdownSupervisor,workerShutdownResult} from "../src/workerShutdownReceipt.js";
const ownerId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const binding=(pid=991001,workerId="app-0",workerGeneration=1)=>({ownerId,pid,processGroupId:pid,workerId,workerGeneration});
const identity=(pid=991001)=>({pid,processGroupId:pid});
const row=(pid:number,parentPid=1)=>({pid,parentPid,processGroupId:pid,state:"S",startedAt:`birth ${pid}`});
function fixture(){let rows=[row(991001),row(991002,991001),row(991011),row(991012,991011)];
 const registry=new SupervisedProcessTreeRegistry(async()=>rows);const actor=new WorkerTreeShutdownSupervisor(registry);
 return{registry,actor,setRows:(value:typeof rows)=>{rows=value;}};}
describe.skipIf(process.platform==="win32")("trusted spawn-bound worker tree supervisor",()=>{
 test("ordinary registration and exact local callbacks bind separate immutable worker receipts",async()=>{
  const f=fixture(),a=binding(),b=binding(991011,"app-1");await f.actor.register(identity(),a);await f.actor.register(identity(991011),b);
  const supervisor=snapshotWorkerShutdownSupervisor(f.actor.supervisor)!;expect(supervisor).toBeDefined();expect(supervisor.pinNonforcingShutdown(a)).toBe(true);
  expect(supervisor.pinNonforcingShutdown(b)).toBe(true);const old=await supervisor.closeNonforcing(a);
  expect(workerShutdownResult(old,a)).toMatchObject({outcome:"timeout",survivors:2});
  expect(workerShutdownResult(await supervisor.closeNonforcing(b),b).survivors).toBe(2);
  expect(Object.isFrozen(old)).toBe(true);expect(Object.isFrozen(old.binding)).toBe(true);expect(Object.isFrozen(old.result)).toBe(true);
  f.actor.markExited(identity(),a);f.setRows([row(991011),row(991012,991011)]);
  expect(workerShutdownResult(await supervisor.observeNonforcingExit(a),a).exited).toBe(true);
  expect((await f.registry.observeNonforcingExit()).survivors).toBe(2);expect(old.result.outcome).toBe("timeout");
 });
 test("shutdown cannot adopt an unregistered supplied PID or another worker generation",async()=>{
  const f=fixture(),a=binding();await f.actor.register(identity(),a);
  expect(()=>f.actor.supervisor.pinNonforcingShutdown({...a,workerGeneration:2})).toThrow("UNCONFIRMED");
  for(const b of [{...a,workerGeneration:2},{...a,ownerId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},{...a,pid:991099}])
   expect(workerShutdownResult(await f.actor.supervisor.observeNonforcingExit(b),b).outcome).toBe("uncertain");
 });
 test("pending registration remains UNKNOWN after later probe completion",async()=>{
  let finish!:(rows:ReturnType<typeof row>[])=>void;const registry=new SupervisedProcessTreeRegistry(()=>new Promise(resolve=>{finish=resolve;}));
  const actor=new WorkerTreeShutdownSupervisor(registry),a=binding();const registration=actor.register(identity(),a);
  expect(()=>actor.supervisor.pinNonforcingShutdown(a)).toThrow("UNCONFIRMED");
  await new Promise(resolve=>setTimeout(resolve,0));finish([row(a.pid)]);await registration;actor.markExited(identity(),a);
  expect((await actor.supervisor.observeNonforcingExit(a)).result.outcome).toBe("uncertain");
 });
 test("registration probe faults do not reject ordinary registration but never approve nonforcing absence",async()=>{
  const registry=new SupervisedProcessTreeRegistry(async()=>{throw Error("probe fault");});const actor=new WorkerTreeShutdownSupervisor(registry),a=binding();
  await expect(actor.register(identity(),a)).resolves.toBeUndefined();expect(registry.size).toBe(1);
  expect(()=>actor.supervisor.pinNonforcingShutdown(a)).toThrow("UNCONFIRMED");actor.markExited(identity(),a);
  expect((await actor.supervisor.observeNonforcingExit(a)).result.outcome).toBe("uncertain");
 });
 test("registration after pin retains the new tree with sticky uncertainty",async()=>{
  const f=fixture(),a=binding();expect(()=>f.actor.supervisor.pinNonforcingShutdown(a)).toThrow("UNCONFIRMED");
  await f.actor.register(identity(),a);f.actor.markExited(identity(),a);f.setRows([]);
  expect((await f.actor.supervisor.observeNonforcingExit(a)).result.outcome).toBe("uncertain");expect(f.registry.size).toBe(1);
 });
 test("callback binding disagreement cannot mark a root exited or clear later observations",async()=>{
  const f=fixture(),a=binding();await f.actor.register(identity(),a);f.actor.supervisor.pinNonforcingShutdown(a);
  f.actor.markExited(identity(),{...a,workerGeneration:2});f.setRows([]);
  expect(f.registry.snapshots()[0].rootExited).toBe(false);expect((await f.actor.supervisor.observeNonforcingExit(a)).result.outcome).toBe("uncertain");
 });
 test("another owner or reused PID cannot borrow a captured generation",async()=>{
  const f=fixture(),a=binding();await f.actor.register(identity(),a);
  expect(()=>f.actor.register(identity(),{...a,ownerId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})).toThrow("OWNER_CHANGED");
  expect(()=>f.actor.register(identity(),{...a,workerGeneration:2})).toThrow("ROOT_REUSED");
  expect(()=>f.actor.supervisor.pinNonforcingShutdown(a)).toThrow("UNCONFIRMED");
 });
 test("association objects are copied and malformed identity accessors are not invoked",async()=>{
  const f=fixture(),a=binding(),i=identity();await f.actor.register(i,a);a.pid=991099;i.pid=991099;
  const original=binding();expect(f.actor.supervisor.pinNonforcingShutdown(original)).toBe(true);
  expect((await f.actor.supervisor.observeNonforcingExit(original)).binding.pid).toBe(original.pid);
  const getter=vi.fn(()=>991011);expect(()=>f.actor.register(Object.defineProperty({processGroupId:991011},"pid",{get:getter}) as never,binding(991011,"app-1"))).toThrow("INVALID");
  expect(getter).not.toHaveBeenCalled();
 });
 test("a faulting exit association arriving during observation remains UNKNOWN",async()=>{
  let rows=[row(991001)];let held=false,finish!:(value:typeof rows)=>void;
  const registry=new SupervisedProcessTreeRegistry(()=>held?new Promise(resolve=>{finish=resolve;}):Promise.resolve(rows));
  const actor=new WorkerTreeShutdownSupervisor(registry),a=binding();await actor.register(identity(),a);actor.supervisor.pinNonforcingShutdown(a);
  held=true;const observing=actor.supervisor.observeNonforcingExit(a);await new Promise(resolve=>setTimeout(resolve,0));
  actor.markExited(identity(),{...a,workerGeneration:2});finish([]);expect((await observing).result.outcome).toBe("uncertain");
 });
 test("default unpinned registry cleanup is preserved and scoped receipts never bypass force history",async()=>{
  const f=fixture(),a=binding();await f.actor.register(identity(),a);const signal=vi.spyOn(process,"kill").mockImplementation((_pid,kind)=>{
   if(kind==="SIGTERM")f.actor.supervisor.pinNonforcingShutdown(a);return true;});
  try{expect(await f.registry.release(identity(),0)).toBe(false);expect(signal.mock.calls.some(([,kind])=>kind==="SIGKILL")).toBe(false);
   expect((await f.actor.supervisor.observeNonforcingExit(a)).result.outcome).toBe("uncertain");
  }finally{signal.mockRestore();}
 });
});
