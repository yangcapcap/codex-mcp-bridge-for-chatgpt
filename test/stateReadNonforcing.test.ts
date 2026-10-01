import {EventEmitter} from "node:events";
import {performance} from "node:perf_hooks";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {shutdownResult} from "../src/shutdown.js";
const h=vi.hoisted(()=>({children:[] as any[],drop:false,exit:true}));
vi.mock("node:child_process",async original=>({...await original<any>(),spawn:(_cmd:any,args:string[])=>{
 const child=new EventEmitter() as any;Object.assign(child,{pid:990201,connected:true,exitCode:null,signalCode:null,sent:[],stderr:new EventEmitter()});
 child.controller=args.at(-1);child.generation="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 child.kill=vi.fn(()=>{child.signalCode="SIGKILL";child.emit("exit",null,"SIGKILL");return true;});
 child.send=vi.fn((request:any,done?:any)=>{
  child.sent.push(request);done?.();
  if(request.type.endsWith("nonforcing") && !h.drop)queueMicrotask(()=>{
   const {type,policy,...binding}=request;
   child.emit("message",{...binding,type:"shutdown-receipt",operation:type,result:shutdownResult("exited")});
   if(type==="finalize-nonforcing" && h.exit){child.exitCode=0;child.emit("exit",0,null);}
  });return true;
 });h.children.push(child);
 queueMicrotask(()=>child.emit("message",{type:"ready",version:3,generation:child.generation,heartbeatAt:Date.now()}));return child;
}}));
import {ChildProcessStateReadService} from "../src/stateReadProcess.js";
const policy={allowSigkillEscalation:false as const,graceMs:0};
async function fixture(){const service=await ChildProcessStateReadService.start("/private/no-test-file-created",{});return {service,child:h.children.at(-1)};}
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(performance,"now").mockImplementation(()=>Date.now());h.children=[];h.drop=false;h.exit=true;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test("read child uses its fixed private IPC controller and actual owned exit for completion",async()=>{
 const {service,child}=await fixture();expect(await service.closeNonforcing(policy)).toEqual(shutdownResult("exited"));
 expect(child.sent.map((r:any)=>r.type)).toEqual(["close-nonforcing","finalize-nonforcing"]);
 expect(child.sent.every((r:any)=>r.controllerId===child.controller)).toBe(true);expect(child.kill).not.toHaveBeenCalled();await service.close();
});
test("read requests and reservation evidence survive pin and late replies without retry or force",async()=>{
 const {service,child}=await fixture();const pending=service.settingsSnapshot().catch(error=>error);const request=child.sent[0];
 await service.closeNonforcing(policy);expect((await pending).message).toContain("OUTCOME_UNKNOWN");
 child.emit("message",{type:"response",generation:child.generation,requestId:request.requestId,ok:true,result:{}});
 expect((service as any).pending.has(request.requestId)).toBe(true);await expect(service.settingsSnapshot()).rejects.toThrow("UNAVAILABLE");
 await vi.advanceTimersByTimeAsync(12000);expect(h.children).toHaveLength(1);expect(child.kill).not.toHaveBeenCalled();
});
test("ordinary force timer cannot resume after a read child nonforcing pin",async()=>{
 const {service,child}=await fixture();const ordinary=service.close().catch(error=>error);
 expect((await service.closeNonforcing(policy)).outcome).toBe("uncertain");expect((await ordinary).message).toContain("UNCONFIRMED");
 await vi.advanceTimersByTimeAsync(12000);expect(child.kill).not.toHaveBeenCalled();
});
test("ordinary shutdown still performs its existing force recovery when no nonforcing policy was requested",async()=>{
 const {service,child}=await fixture();const closing=service.close();await vi.advanceTimersByTimeAsync(2000);await closing;
 expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
test("missing read child receipts retain UNKNOWN and never escalate",async()=>{
 const {service,child}=await fixture();h.drop=true;const closing=service.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(18100);
 expect((await closing).outcome).toBe("uncertain");expect(child.kill).not.toHaveBeenCalled();await expect(service.close()).rejects.toThrow("UNCONFIRMED");
});
test("a live read owner remains a survivor even when its resource receipt says zero",async()=>{
 const {service,child}=await fixture();h.exit=false;const closing=service.closeNonforcing(policy);expect(service.health().ready).toBe(false);await vi.advanceTimersByTimeAsync(6100);
  const old=await closing;expect(old).toMatchObject({outcome:"timeout",survivors:1});child.exitCode=0;child.emit("exit",0,null);
 expect((await service.observeNonforcingExit()).exited).toBe(true);expect(old.outcome).toBe("timeout");
});
test("read argument serialization cannot admit a new request after a reentrant pin",async()=>{
 const {service,child}=await fixture();let closing:Promise<ReturnType<typeof shutdownResult>>|undefined;
 const request=service.settingsSnapshot({toJSON(){closing=service.closeNonforcing(policy);return {};}} as any);
 await expect(request).rejects.toThrow("OUTCOME_UNKNOWN");await closing;expect((service as any).pending.size).toBe(0);
 expect(child.sent.every((r:any)=>r.type.endsWith("nonforcing"))).toBe(true);
});
