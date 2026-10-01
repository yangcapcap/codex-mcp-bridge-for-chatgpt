import {EventEmitter} from "node:events";
import {performance} from "node:perf_hooks";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import type {ChildProcess} from "node:child_process";
import {OwnedProcessShutdown,beginOrdinaryOwnedProcessStop,isOwnedProcessNonforcing} from "../src/ownedProcessShutdown.js";
import {shutdownResult} from "../src/shutdown.js";
const gen="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",policy={allowSigkillEscalation:false as const,graceMs:0};
function fixture(){
 const child=new EventEmitter() as ChildProcess & {sent:any[]};Object.assign(child,{pid:990102,connected:true,exitCode:null,signalCode:null,sent:[]});
 let exit=true,result=shutdownResult("exited"),drop=false;
 // Send strict receipt fields only, without copied policy/type extras.
 child.send=vi.fn((request:any,done:any)=>{child.sent.push(request);done?.();if(!drop)queueMicrotask(()=>{
  const {policy,type,...binding}=request;child.emit("message",{...binding,type:"shutdown-receipt",operation:type,result});
  if(type==="finalize-nonforcing" && exit)Object.assign(child,{exitCode:0});
 });return false;}) as never;
 const hooks={generation:()=>gen,pin:vi.fn(()=>true as const)};const owner=new OwnedProcessShutdown(child,hooks);
 return {child,owner,hooks,setExit:(v:boolean)=>{exit=v;},setResult:(v:typeof result)=>{result=v;},drop:()=>{drop=true;}};
}
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(performance,"now").mockImplementation(()=>Date.now());});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test("pins the exact owned child before hooks, correlates finalization and accepts IPC backpressure delivery",async()=>{
 const f=fixture();f.hooks.pin.mockImplementation(()=>{expect(isOwnedProcessNonforcing(f.child)).toBe(true);return true as const;});
 expect(await f.owner.closeNonforcing(policy)).toEqual(shutdownResult("exited"));expect(beginOrdinaryOwnedProcessStop(f.child)).toBe(false);
 expect(f.child.sent.map(r=>r.type)).toEqual(["close-nonforcing","finalize-nonforcing"]);await f.owner.closeAfterPin();
});
test("a valid resources receipt does not prove the original child handle exited",async()=>{
 const f=fixture();f.setExit(false);const pending=f.owner.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(6100);
 const old=await pending;expect(old).toMatchObject({outcome:"timeout",survivors:1});
 Object.assign(f.child,{exitCode:0});expect((await f.owner.observeNonforcingExit()).exited).toBe(true);expect(old.outcome).toBe("timeout");
 await expect(f.owner.closeAfterPin()).rejects.toThrow("UNCONFIRMED");
});
test("fresh resources observation may finalize after an immutable initial timeout",async()=>{
 const f=fixture();f.setResult(shutdownResult("timeout",1));const old=await f.owner.closeNonforcing(policy);
 expect(old.survivors).toBe(2);f.setResult(shutdownResult("exited"));expect((await f.owner.observeNonforcingExit()).exited).toBe(true);
 expect(old.outcome).toBe("timeout");
});
test("prior ordinary child shutdown is sticky UNKNOWN even after valid receipt and actual exit",async()=>{
 const f=fixture();expect(beginOrdinaryOwnedProcessStop(f.child)).toBe(true);
 expect((await f.owner.closeNonforcing(policy)).outcome).toBe("uncertain");expect((await f.owner.observeNonforcingExit()).outcome).toBe("uncertain");
});
test("generation capability mutation cannot substitute a new owner after capture",async()=>{
 const f=fixture();f.hooks.generation=()=>"invalid";expect((await f.owner.closeNonforcing(policy)).exited).toBe(true);
});
test("pin failure retains the process fence and returns UNKNOWN without sending a close",async()=>{
 const f=fixture();f.hooks.pin.mockImplementation(()=>{throw Error("fault");});expect((await f.owner.closeNonforcing(policy)).outcome).toBe("uncertain");
 expect(f.child.sent).toHaveLength(0);expect(beginOrdinaryOwnedProcessStop(f.child)).toBe(false);
});
test("missing original generation never acquires proof from a later ready message",async()=>{
 const f=fixture();const owner=new OwnedProcessShutdown(f.child,{generation:()=>undefined,pin(){return true as const;}});
 expect((await owner.closeNonforcing(policy)).outcome).toBe("uncertain");expect((await owner.observeNonforcingExit()).outcome).toBe("uncertain");
});
test("missing receipt times out as UNKNOWN without a force fallback",async()=>{
 const f=fixture();f.drop();const pending=f.owner.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(18100);
 expect((await pending).outcome).toBe("uncertain");expect(f.child.sent).toHaveLength(1);
});
test("another child PID cannot satisfy the captured owner identity",async()=>{
 const f=fixture();await f.owner.closeNonforcing(policy);Object.assign(f.child,{pid:990103});
 expect((await f.owner.observeNonforcingExit()).outcome).toBe("uncertain");
});
test("contradictory correlated receipts permanently invalidate fresh proof",async()=>{
 const f=fixture();await f.owner.closeNonforcing(policy);const {type,policy:originalPolicy,...binding}=f.child.sent[0];
 f.child.emit("message",{...binding,type:"shutdown-receipt",operation:type,result:shutdownResult("uncertain")});
 expect((await f.owner.observeNonforcingExit()).outcome).toBe("uncertain");
});
test("reentrant pin hooks share one sealed close request",async()=>{
 const f=fixture();f.hooks.pin.mockImplementation(()=>{void f.owner.closeNonforcing(policy);return true as const;});
 expect((await f.owner.closeNonforcing(policy)).exited).toBe(true);expect(f.hooks.pin).toHaveBeenCalledOnce();
});
test("another controller or close nonce cannot supply an issued receipt",async()=>{
 const f=fixture();f.drop();const pending=f.owner.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(1);
 const {type,policy:originalPolicy,...binding}=f.child.sent[0];f.child.emit("message",{...binding,controllerId:gen,type:"shutdown-receipt",operation:type,result:shutdownResult("exited")});
 await vi.advanceTimersByTimeAsync(18100);expect((await pending).outcome).toBe("uncertain");
});

test.each(["false","void","promise"])("a %s pin acknowledgement does not authorize IPC shutdown",async mode=>{
 const f=fixture();f.hooks.pin.mockImplementation(()=>mode==="false"?false as never:mode==="void"?undefined as never:Promise.resolve(true) as never);
 expect((await f.owner.closeNonforcing(policy)).outcome).toBe("uncertain");expect(f.child.sent).toHaveLength(0);expect(beginOrdinaryOwnedProcessStop(f.child)).toBe(false);
});
