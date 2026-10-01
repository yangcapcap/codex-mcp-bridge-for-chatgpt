import {afterEach,describe,expect,test,vi} from "vitest";
import {ExecutionShutdownOwner,observeResourcesAfterClose} from "../src/executionShutdownOwner.js";
import {snapshotExecutionShutdownRequest,snapshotExecutionShutdownReceipt} from "../src/executionShutdownProtocol.js";
import {shutdownResult} from "../src/shutdown.js";
const generation="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",controllerId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",closeId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const id="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const close=()=>({type:"close-nonforcing" as const,generation,ownerPid:990101,controllerId,requestId:closeId,closeRequestId:closeId,policy:{allowSigkillEscalation:false as const,graceMs:0}});
const later=(type:"observe-nonforcing"|"finalize-nonforcing",requestId=id)=>{const {policy,...r}=close();return {...r,type,requestId};};
function fixture(){const hooks={pin:vi.fn(()=>true as const),close:vi.fn(async()=>shutdownResult("exited")),observe:vi.fn(async()=>shutdownResult("exited"))};
 return {hooks,owner:new ExecutionShutdownOwner(generation,990101,hooks)};}
afterEach(()=>vi.useRealTimers());
describe("authenticated owner shutdown correlation and sealed history",()=>{
 test("enclosing owner refreshes a pre-exit pool timeout without rewriting its original receipt",async()=>{
  const old=shutdownResult("timeout",1),observe=vi.fn(async()=>shutdownResult("exited"));
  expect((await observeResourcesAfterClose(old,observe)).exited).toBe(true);expect(observe).toHaveBeenCalledOnce();
  expect(old.outcome).toBe("timeout");expect(old.survivors).toBe(1);
 });
 test("fresh observation still reports a real retained descendant",async()=>{
  expect(await observeResourcesAfterClose(shutdownResult("timeout",2),async()=>shutdownResult("timeout",1))).toEqual(shutdownResult("timeout",1));
 });
 test.each(["exited","uncertain"] as const)("%s initial resource receipt does not request a success upgrade",async outcome=>{
  const observe=vi.fn(async()=>shutdownResult("exited"));expect((await observeResourcesAfterClose(shutdownResult(outcome),observe)).outcome).toBe(outcome);
  expect(observe).not.toHaveBeenCalled();
 });
 test.each(["void","reject"])("a %s fresh resources observation remains UNKNOWN",async mode=>{
  const result=await observeResourcesAfterClose(shutdownResult("timeout",1),async()=>{if(mode==="reject")throw Error("fault");return undefined as never;});
  expect(result.outcome).toBe("uncertain");
 });
 test("fresh resources observation is bounded and cannot rewrite its original timeout after late success",async()=>{
  vi.useFakeTimers();const old=shutdownResult("timeout",1);let finish!:(r:ReturnType<typeof shutdownResult>)=>void;
  const pending=observeResourcesAfterClose(old,()=>new Promise(done=>{finish=done;}));await vi.advanceTimersByTimeAsync(6000);
  const current=await pending;expect(current.outcome).toBe("uncertain");finish(shutdownResult("exited"));await Promise.resolve();
  expect(old.outcome).toBe("timeout");expect(current.outcome).toBe("uncertain");
 });
 test("a cached successful receipt cannot authorize a new finalization after observation uncertainty",async()=>{
  const f=fixture();await f.owner.handle(close(),controllerId);const old=await f.owner.handle(later("finalize-nonforcing"),controllerId);
  expect(f.owner.finalizationAllowed).toBe(true);f.owner.invalidateObservation();
  expect(await f.owner.handle(later("finalize-nonforcing"),controllerId)).toBe(old);
  expect(old!.result.exited).toBe(true);expect(f.owner.finalizationAllowed).toBe(false);
 });
 test("pins before yielding and returns only an exact copied immutable close receipt",async()=>{
  const f=fixture(),request=close(),result=f.owner.handle(request,controllerId);expect(f.owner.pinned).toBe(true);expect(f.hooks.pin).toHaveBeenCalledOnce();
  request.policy.graceMs=99;const receipt=(await result)!;expect(receipt.result.exited).toBe(true);
  expect(Object.isFrozen(receipt)).toBe(true);expect(Object.isFrozen(receipt.result)).toBe(true);
  expect(snapshotExecutionShutdownReceipt(receipt,snapshotExecutionShutdownRequest(close())!)).toEqual(receipt);
  expect(f.hooks.pin.mock.calls[0][0].graceMs).toBe(0);
 });
 test.each(["generation","ownerPid","controllerId"])("rejects a different authenticated %s without installing a fence",async field=>{
  const f=fixture();expect(await f.owner.handle({...close(),[field]:field==="ownerPid"?990102:id},controllerId)).toBeUndefined();
  expect(f.owner.pinned).toBe(false);expect(f.hooks.pin).not.toHaveBeenCalled();
 });
 test("frame controller claims cannot replace the current authenticated link controller",async()=>{
  const f=fixture();expect(await f.owner.handle(close(),id)).toBeUndefined();expect(f.owner.pinned).toBe(false);
 });
 test.each(["observe-nonforcing","finalize-nonforcing"] as const)("%s cannot precede the original close",async type=>{
  const f=fixture();expect(await f.owner.handle(later(type),controllerId)).toBeUndefined();expect(f.hooks.observe).not.toHaveBeenCalled();
 });
 test("synchronous pin reentrancy shares the already sealed close operation",async()=>{
  const hooks={pin:()=>{void owner.handle(close(),controllerId);return true as const;},close:vi.fn(async()=>shutdownResult("exited")),observe:async()=>shutdownResult("exited")};
  const owner=new ExecutionShutdownOwner(generation,990101,hooks);const receipt=await owner.handle(close(),controllerId);
  expect(receipt!.result.exited).toBe(true);expect(hooks.close).toHaveBeenCalledOnce();
 });
 test("repeat close cannot change the original ID, owner binding or grace",async()=>{
  const f=fixture(),a=await f.owner.handle(close(),controllerId);
  expect(await f.owner.handle({...close(),policy:{allowSigkillEscalation:false,graceMs:1}},controllerId)).toBeUndefined();
  expect(await f.owner.handle({...close(),requestId:id,closeRequestId:id},controllerId)).toBeUndefined();
  expect(await f.owner.handle(close(),controllerId)).toBe(a);expect(f.hooks.close).toHaveBeenCalledOnce();
 });
 test("fresh observation and finalization retain the original close and never rewrite its timeout",async()=>{
  const f=fixture();f.hooks.close.mockResolvedValue(shutdownResult("timeout",1));const old=(await f.owner.handle(close(),controllerId))!;
  const observation=(await f.owner.handle(later("observe-nonforcing"),controllerId))!;
  expect(observation.result.exited).toBe(true);expect(old.result.outcome).toBe("timeout");
  expect(await f.owner.handle(later("finalize-nonforcing"),controllerId)).toBeUndefined();
  expect((await f.owner.handle(later("finalize-nonforcing","ffffffff-ffff-4fff-8fff-ffffffffffff"),controllerId))!.operation).toBe("finalize-nonforcing");
 });
 test("ordinary close history stays UNKNOWN even when close and fresh probes report exit",async()=>{
  const f=fixture();f.owner.markOrdinaryShutdown();const old=(await f.owner.handle(close(),controllerId))!;
  expect(old.result.outcome).toBe("uncertain");expect((await f.owner.handle(later("observe-nonforcing"),controllerId))!.result.outcome).toBe("uncertain");
  expect(f.hooks.observe).not.toHaveBeenCalled();
 });
 test("later ordinary history cannot rewrite an old receipt but invalidates new observations",async()=>{
  const f=fixture(),old=(await f.owner.handle(close(),controllerId))!;f.owner.markOrdinaryShutdown();
  expect((await f.owner.handle(later("observe-nonforcing"),controllerId))!.result.outcome).toBe("uncertain");expect(old.result.exited).toBe(true);
 });
 test.each(["throw","false"])("a %s synchronous fence returns UNKNOWN without invoking close",async kind=>{
  const f=fixture();f.hooks.pin.mockImplementation(()=>{if(kind==="throw")throw Error("fault");return false as never;});
  expect((await f.owner.handle(close(),controllerId))!.result.outcome).toBe("uncertain");expect(f.hooks.close).not.toHaveBeenCalled();
 });
 test.each(["void","reject"])("a %s close never certifies exit",async kind=>{
  const f=fixture();f.hooks.close.mockImplementation(async()=>{if(kind==="reject")throw Error("fault");return undefined as never;});
  expect((await f.owner.handle(close(),controllerId))!.result.outcome).toBe("uncertain");
 });
 test("late close success cannot rewrite the bounded immutable receipt",async()=>{
  vi.useFakeTimers();const f=fixture();let finish!:(value:ReturnType<typeof shutdownResult>)=>void;
  f.hooks.close.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));const promise=f.owner.handle(close(),controllerId);
  await vi.advanceTimersByTimeAsync(6000);const old=(await promise)!;expect(old.result.outcome).toBe("uncertain");
  finish(shutdownResult("exited"));await Promise.resolve();expect(old.result.outcome).toBe("uncertain");
 });
 test("a malformed request accessor is rejected without invoking caller code",async()=>{
  const f=fixture(),get=vi.fn(()=>"close-nonforcing");expect(await f.owner.handle(Object.defineProperty(close(),"type",{get}),controllerId)).toBeUndefined();
  expect(get).not.toHaveBeenCalled();expect(f.owner.pinned).toBe(false);
 });
 test("capability methods are captured once and getter fields are rejected",async()=>{
  const f=fixture();f.hooks.close=vi.fn(async()=>shutdownResult("timeout",1));expect((await f.owner.handle(close(),controllerId))!.result.exited).toBe(true);
  const get=vi.fn(()=>()=>true);expect(()=>new ExecutionShutdownOwner(generation,990101,Object.defineProperty({...f.hooks},"pin",{get}) as never)).toThrow("CAPABILITY_INVALID");
  expect(get).not.toHaveBeenCalled();
 });
});
