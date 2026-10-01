import {EventEmitter} from "node:events";
import {performance} from "node:perf_hooks";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import {shutdownResult} from "../src/shutdown.js";
const h=vi.hoisted(()=>({children:[] as any[],drop:false,exit:true}));
vi.mock("node:child_process",async original=>({...await original<any>(),spawn:(_cmd:any,args:string[])=>{
 const child=new EventEmitter() as any;Object.assign(child,{pid:990311,connected:true,exitCode:null,signalCode:null,sent:[],callbacks:[],stderr:new EventEmitter()});
 child.controller=args[args.indexOf("--bridge-telemetry-child")+3];child.generation="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 child.kill=vi.fn(()=>{child.signalCode="SIGKILL";child.emit("exit",null,"SIGKILL");return true;});
 child.send=vi.fn((request:any,done?:any)=>{
  child.sent.push(request);child.callbacks.push(done);
  if(request.type.endsWith("nonforcing") && !h.drop)queueMicrotask(()=>{
   done?.();const {type,policy,...binding}=request;
   child.emit("message",{...binding,type:"shutdown-receipt",operation:type,result:shutdownResult("exited")});
   if(type==="finalize-nonforcing" && h.exit){child.exitCode=0;child.emit("exit",0,null);}
  });return true;
 });h.children.push(child);
 queueMicrotask(()=>child.emit("message",{type:"ready",generation:child.generation,records:[],nextRecordId:1,dropCounters:[]}));return child;
}}));
import {ChildProcessTelemetryService} from "../src/telemetryService.js";
const policy={allowSigkillEscalation:false as const,graceMs:0};
const record={severity:"info" as const,component:"state" as const,code:"test.close"};
async function fixture(){const service=await ChildProcessTelemetryService.start("/private/no-test-file-created");return {service,child:h.children.at(-1)};}
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(performance,"now").mockImplementation(()=>Date.now());h.children=[];h.drop=false;h.exit=true;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test("telemetry shutdown binds its spawn controller, generation and actual owned exit",async()=>{
 const {service,child}=await fixture();expect(await service.closeNonforcing(policy)).toEqual(shutdownResult("exited"));
 expect(child.sent.map((r:any)=>r.type)).toEqual(["close-nonforcing","finalize-nonforcing"]);
 expect(child.sent.every((r:any)=>r.controllerId===child.controller && r.generation===child.generation)).toBe(true);
 expect(child.kill).not.toHaveBeenCalled();expect(service.status().connected).toBe(false);await service.close();
});
test("queued, in-flight and drop evidence survive pin, late ACK, send errors and owned exit",async()=>{
 const {service,child}=await fixture();service.recordDiagnosticEvent(record);service.recordDiagnosticEvent(record);
 (service as any).noteDrop("test.pending");const first=child.sent[0];const before=service.status();const dropCounters=new Map((service as any).dropCounters);
 await service.closeNonforcing(policy);
 child.emit("message",{type:"ack",recordType:first.entry.recordType,deliveryId:first.entry.deliveryId,recordId:999,ok:true,persistedAt:Date.now()});
 child.callbacks[0]?.(new Error("late transport error"));child.emit("message",{type:"drop-ack",ok:true});
 expect(service.status()).toMatchObject({queued:before.queued,inFlight:before.inFlight,dropped:before.dropped});expect((service as any).dropCounters).toEqual(dropCounters);
 expect((service as any).inFlight.value.deliveryId).toBe(first.entry.deliveryId);expect(service.processId).toBe(child.pid);
 await vi.advanceTimersByTimeAsync(15000);expect(h.children).toHaveLength(1);expect(child.kill).not.toHaveBeenCalled();
});
test("all telemetry admission paths reject after pin without adding or dropping evidence",async()=>{
 const {service,child}=await fixture();await service.closeNonforcing(policy);const before=service.status();
 expect(service.recordDiagnosticEvent(record)).toBe(false);expect(service.recordRuntimeMeasurement({component:"state",metric:"test",durationMs:1})).toBe(false);
 expect(service.recordTransportObservation({kind:"status-wait-aborted",reasonCode:"test"},"cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBeUndefined();
 expect(service.status()).toEqual(before);expect(child.sent).toHaveLength(2);
});
test("ordinary flush continuation retains its queue when a nonforcing pin interrupts it",async()=>{
 const {service,child}=await fixture();service.recordDiagnosticEvent(record);service.recordDiagnosticEvent(record);
 const ordinary=service.close().catch(error=>error);const before=service.status();
 expect((await service.closeNonforcing(policy)).outcome).toBe("uncertain");await vi.advanceTimersByTimeAsync(1200);
 expect((await ordinary).message).toContain("UNCONFIRMED");expect(service.status()).toMatchObject({queued:before.queued,inFlight:before.inFlight,dropped:before.dropped});
 expect(child.kill).not.toHaveBeenCalled();expect(child.sent.every((r:any)=>r.type!=="close")).toBe(true);
});
test("ordinary force timer is fenced while unrequested ordinary recovery is preserved",async()=>{
 const first=await fixture();const ordinary=first.service.close().catch(error=>error);
 expect((await first.service.closeNonforcing(policy)).outcome).toBe("uncertain");expect((await ordinary).message).toContain("UNCONFIRMED");
 await vi.advanceTimersByTimeAsync(12000);expect(first.child.kill).not.toHaveBeenCalled();
 const second=await fixture();const closing=second.service.close();await vi.advanceTimersByTimeAsync(2100);await closing;expect(second.child.kill).toHaveBeenCalledWith("SIGKILL");
});
test("missing receipts keep telemetry shutdown UNKNOWN and never force or restart",async()=>{
 const {service,child}=await fixture();h.drop=true;const closing=service.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(18100);
 expect((await closing).outcome).toBe("uncertain");expect(child.kill).not.toHaveBeenCalled();expect(h.children).toHaveLength(1);await expect(service.close()).rejects.toThrow("UNCONFIRMED");
});
test("resource zero cannot certify a live telemetry owner and the original TIMEOUT stays immutable",async()=>{
 const {service,child}=await fixture();h.exit=false;const closing=service.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(6100);
 const original=await closing;expect(original).toMatchObject({outcome:"timeout",survivors:1});child.exitCode=0;child.emit("exit",0,null);
 expect((await service.observeNonforcingExit()).exited).toBe(true);expect(original.outcome).toBe("timeout");await expect(service.close()).rejects.toThrow("UNCONFIRMED");
});
test("reentrant normalization cannot enqueue diagnostics after a pin",async()=>{
 const {service,child}=await fixture();let closing:Promise<any>|undefined;
 expect(service.recordRuntimeMeasurement({component:"state",metric:"test",get durationMs(){closing=service.closeNonforcing(policy);return 1;}})).toBe(false);
 await closing;expect(service.status()).toMatchObject({queued:0,inFlight:0});expect(child.sent.every((r:any)=>r.type.endsWith("nonforcing"))).toBe(true);
});
