import {EventEmitter} from "node:events";
import {performance} from "node:perf_hooks";
import {afterEach,beforeEach,describe,expect,test,vi} from "vitest";
import {shutdownResult} from "../src/shutdown.js";
const h=vi.hoisted(()=>({peers:[] as any[],result:"exited",exitOnFinalize:true,drop:false,bad:false,reattached:false}));
vi.mock("../src/executionTransport.js",async original=>{
 const real=await original<any>();
 return {...real,readExecutionRecord:()=>[],ExecutionPeer:class extends EventEmitter {
  pid=990101;connected=true;exitCode:number|null=null;signalCode=null;pinned=false;sent:any[]=[];ordinary=false;
  binding={generation:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",ownerPid:this.pid,controllerId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"};
  constructor(){super();h.peers.push(this);}
  start(){this.emit("message",{type:"ready",protocol:"bridge-codex-execution",version:7,generation:this.binding.generation,heartbeatAt:Date.now(),capabilities:{}});}
  get nonforcingBinding(){return this.pinned?this.binding:undefined;}
  pinNonforcingShutdown(){this.pinned=true;return this.binding;}
  observeNonforcingExit(){return h.reattached||this.ordinary?shutdownResult("uncertain"):this.exitCode===null?shutdownResult("timeout",1):shutdownResult("exited");}
  send(value:any,done?:(error?:Error)=>void){
   this.sent.push(value);done?.();
   if(value.type==="close"){this.ordinary=true;return true;}
   if(!value.type.endsWith("nonforcing")||h.drop)return true;
   queueMicrotask(()=>{
    this.emit("message",{...this.binding,type:"shutdown-receipt",operation:value.type,requestId:value.requestId,
     closeRequestId:h.bad?"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":value.closeRequestId,
     result:shutdownResult(h.result as any,h.result==="timeout"?1:0)});
    if(value.type==="finalize-nonforcing"&&h.exitOnFinalize){this.exitCode=0;this.emit("exit",0,null);}
   });return true;
  }
  kill=vi.fn(()=>false);detach=vi.fn();
 }};
});
import {ChildProcessCodexExecutionService} from "../src/executionServiceProcess.js";
const policy={allowSigkillEscalation:false as const,graceMs:0};
async function fixture(){const service=await ChildProcessCodexExecutionService.start({command:"unused",poolSize:1,endpoint:{directory:"/private/no-task-files-created",token:"synthetic"}});return {service,peer:h.peers.at(-1)};}
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(performance,"now").mockImplementation(()=>Date.now());h.peers=[];h.result="exited";h.exitOnFinalize=true;h.drop=false;h.bad=false;h.reattached=false;});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe("execution controller correlated nonforcing receipt and actual exit conjunction",()=>{
 test("argument serialization cannot create a new reservation after a reentrant pin",async()=>{
  const {service,peer}=await fixture();let closing:ReturnType<typeof service.closeNonforcing>|undefined;
  const request=service.callTool("codex",{toJSON(){closing=service.closeNonforcing(policy);return {prompt:"never delivered"};}});
  await expect(request).rejects.toThrow("OUTCOME_UNKNOWN");await closing;
  expect((service as any).pending.size).toBe(0);expect(peer.sent.every((m:any)=>m.type.endsWith("nonforcing"))).toBe(true);
 });
 test("needs a fresh finalize receipt and actual owned exit; preserves ordinary close compatibility afterward",async()=>{
  const {service,peer}=await fixture();const result=await service.closeNonforcing(policy);
  expect(result).toEqual(shutdownResult("exited"));expect(peer.sent.map((x:any)=>x.type)).toEqual(["close-nonforcing","finalize-nonforcing"]);
  expect(peer.sent[1].requestId).not.toBe(peer.sent[0].requestId);expect(peer.sent[1].closeRequestId).toBe(peer.sent[0].requestId);
  expect(peer.kill).not.toHaveBeenCalled();expect(peer.detach).not.toHaveBeenCalled();await service.close();
 });
 test("worker EXIT cannot certify a live execution owner, and a later real exit does not rewrite the old timeout",async()=>{
  const {service,peer}=await fixture();h.exitOnFinalize=false;const closing=service.closeNonforcing(policy);
  await vi.advanceTimersByTimeAsync(6100);const old=await closing;expect(old).toMatchObject({outcome:"timeout",survivors:1});
  peer.exitCode=0;peer.emit("exit",0,null);expect(await service.observeNonforcingExit()).toEqual(shutdownResult("exited"));
  expect(old.outcome).toBe("timeout");expect(peer.kill).not.toHaveBeenCalled();
 });
 test("fresh observation may resolve a worker timeout before requesting finalization",async()=>{
  const {service,peer}=await fixture();h.result="timeout";const old=await service.closeNonforcing(policy);expect(old.outcome).toBe("timeout");
  h.result="exited";expect(await service.observeNonforcingExit()).toEqual(shutdownResult("exited"));
  expect(peer.sent.map((x:any)=>x.type)).toEqual(["close-nonforcing","observe-nonforcing","finalize-nonforcing"]);expect(old.outcome).toBe("timeout");
 });
 test.each(["missing","wrong-close"])("%s receipt stays UNKNOWN and never invokes ordinary cleanup",async mode=>{
  const {service,peer}=await fixture();h.drop=mode==="missing";h.bad=mode==="wrong-close";
  const closing=service.closeNonforcing(policy);await vi.advanceTimersByTimeAsync(18100);
  expect((await closing).outcome).toBe("uncertain");expect(peer.sent).toHaveLength(1);expect(peer.kill).not.toHaveBeenCalled();
  await expect(service.close()).rejects.toThrow("UNCONFIRMED");
 });
 test("reattached owner has no owned-handle proof even with zero worker receipts",async()=>{
  const {service}=await fixture();h.reattached=true;expect((await service.closeNonforcing(policy)).outcome).toBe("uncertain");
 });
 test("pin cancels an already scheduled ordinary force timer and retains uncertain history",async()=>{
  const {service,peer}=await fixture();const ordinary=service.close().catch(error=>error);
  const result=await service.closeNonforcing(policy);expect(result.outcome).toBe("uncertain");
  await ordinary;await vi.advanceTimersByTimeAsync(10000);expect(peer.kill).not.toHaveBeenCalled();
  expect((await service.observeNonforcingExit()).outcome).toBe("uncertain");
 });
 test("pin retains pending, ACK and release evidence through late terminal messages and actual exit",async()=>{
  const {service,peer}=await fixture();const internals=service as any;
  const pending=service.readAccountRateLimits().catch(error=>error);
  const request=peer.sent.at(-1);const released=vi.fn();internals.acknowledgements.add(request.requestId);internals.releasedReplies.set(request.requestId,released);
  await service.closeNonforcing(policy);expect((await pending).message).toContain("OUTCOME_UNKNOWN");
  peer.emit("message",{type:"response",generation:peer.binding.generation,requestId:request.requestId,ok:true,result:{}});
  peer.emit("message",{type:"acknowledged",generation:peer.binding.generation,requestId:request.requestId});
  expect(internals.pending.has(request.requestId)).toBe(true);expect(internals.acknowledgements.has(request.requestId)).toBe(true);
  expect(internals.releasedReplies.has(request.requestId)).toBe(true);expect(released).not.toHaveBeenCalled();
  await expect(service.recoverExecution("new-job")).rejects.toThrow("OUTCOME_UNKNOWN");
  const count=peer.sent.length;service.acknowledgeExecution("new-job");expect(peer.sent).toHaveLength(count);
 });
 test("same nonce contradictory valid receipts make fresh observations permanently UNKNOWN",async()=>{
  const {service,peer}=await fixture();await service.closeNonforcing(policy);const request=peer.sent[0];
  peer.emit("message",{...peer.binding,type:"shutdown-receipt",operation:request.type,requestId:request.requestId,closeRequestId:request.closeRequestId,result:shutdownResult("uncertain")});
  expect((await service.observeNonforcingExit()).outcome).toBe("uncertain");
 });
 test("detaching after pin preserves release evidence and cannot manufacture a success",async()=>{
  const {service}=await fixture();await service.closeNonforcing(policy);const internal=service as any,released=vi.fn();internal.releasedReplies.set("retained",released);
  service.detachExecution();expect(released).not.toHaveBeenCalled();expect(internal.releasedReplies.has("retained")).toBe(true);
  expect((await service.observeNonforcingExit()).outcome).toBe("uncertain");
 });
});
