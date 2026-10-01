import {test, expect, vi} from "vitest";
import {randomUUID} from "node:crypto";
import {CodexJobRegistry} from "../src/tools.js";
import {BridgeStateStore} from "../src/stateStore.js";
import type {ToolResult, CodexProgress, UpstreamWorkerAssignment} from "../src/upstream.js";

const result: ToolResult = {content:[{type:"text",text:"retained"}],structuredContent:{threadId:"thread-retained"}};
function input() {return {operation:"start" as const,cwd:process.cwd(),sandbox:"read-only" as const,
 scopeId:randomUUID(),requestId:randomUUID(),requestHash:"a".repeat(64),requestHashVersion:2 as const,
 exclusiveKeys:[],sessionDecision:{requestedMode:"new" as const,action:"start" as const,reason:"explicit-new" as const}};}
function fixture() {const state=new BridgeStateStore({file:":memory:"});const jobs=new CodexJobRegistry({stateStore:state,allowedRoots:[process.cwd()]});return {state,jobs};}
test("registry quiet pin is synchronous and forbids subsequent admission",()=>{
 const {state,jobs}=fixture();try{expect(jobs.pinNonforcingShutdown()).toBe(true);expect(jobs.observeNonforcingExit().exited).toBe(true);expect(()=>jobs.start(input(),async()=>result)).toThrow("NONFORCING_SHUTDOWN_PINNED");expect(jobs.list()).toHaveLength(0);expect(jobs.pinNonforcingShutdown()).toBe(true);}finally{state.close();}
});
test("registry same-tick pin prevents execution and retains the original running job",async()=>{
 const {state,jobs}=fixture();const run=vi.fn(async()=>result);const job=jobs.start(input(),run);const before={...job};
 try{jobs.pinNonforcingShutdown();await job.promise;expect(run).not.toHaveBeenCalled();expect(job.status).toBe(before.status);expect(job.version).toBe(before.version);expect((jobs as any).deferredSettlements.has(job.jobId)).toBe(true);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test.each(["resolve","reject"] as const)("registry late %s keeps owner result, journal and ACK unconfirmed",async outcome=>{
 const {state,jobs}=fixture();const acknowledge=vi.fn();jobs.attachUpstream({listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:acknowledge});
 let finish!:(value:ToolResult)=>void,fail!:(value:unknown)=>void,progress!:(value:CodexProgress)=>void,assigned!:(value:UpstreamWorkerAssignment)=>void;
 const completion=vi.fn(),assignment=vi.fn();const job=jobs.start(input(),async(p,a)=>{progress=p;assigned=a;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});},completion,30,false,assignment);
 await Promise.resolve();await Promise.resolve();const before={status:job.status,version:job.version,worker:job.workerId,progress:job.lastProgress};
 try{jobs.pinNonforcingShutdown();progress({progress:42,message:"late"});assigned({backendKind:"app-server",workerId:"late-worker",workerGeneration:9});if(outcome==="resolve")finish(result);else fail(new Error("late outcome"));await job.promise;
 expect({status:job.status,version:job.version,worker:job.workerId,progress:job.lastProgress}).toEqual(before);expect(acknowledge).not.toHaveBeenCalled();expect(completion).not.toHaveBeenCalled();expect(assignment).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.has(job.jobId)).toBe(true);expect((jobs as any).nonforcingLateObservationCount).toBeGreaterThanOrEqual(2);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry deferred execution cannot launch or discard after pin",()=>{
 const {state,jobs}=fixture();const run=vi.fn(async()=>result);const job=jobs.start(input(),run,undefined,30,false,undefined,true);
 try{jobs.pinNonforcingShutdown();expect(()=>jobs.activateDeferredExecution(job.jobId)).toThrow("NONFORCING_SHUTDOWN_PINNED");expect(()=>jobs.discardDeferredAdmission(job.jobId)).toThrow("NONFORCING_SHUTDOWN_PINNED");expect((jobs as any).deferredExecutions.has(job.jobId)).toBe(true);expect(run).not.toHaveBeenCalled();expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry same-tick cancellation wrapper retains its map and never delegates",async()=>{
 const {state,jobs}=fixture();const operation=vi.fn(async()=>({ok:true}));const pending=jobs.runCancellationMutation(randomUUID(),randomUUID(),"a".repeat(64),operation);
 try{jobs.pinNonforcingShutdown();await expect(pending).rejects.toThrow("NONFORCING_SHUTDOWN_PINNED");expect(operation).not.toHaveBeenCalled();expect((jobs as any).cancellationOperationsInFlight.size).toBe(1);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry late cancellation outcome retains its in-flight identity",async()=>{
 const {state,jobs}=fixture();let finish!:(value:unknown)=>void;const pending=jobs.runCancellationMutation(randomUUID(),randomUUID(),"a".repeat(64),()=>new Promise(r=>{finish=r;}));await Promise.resolve();
 try{jobs.pinNonforcingShutdown();finish({ok:true});await pending;expect((jobs as any).cancellationOperationsInFlight.size).toBe(1);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry ordinary close history cannot become nonforcing EXIT",async()=>{
 const {state,jobs}=fixture();try{await jobs.closeThreadConnections();jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry a failed leaf pin attempts other owned leaves but never acknowledges positively",()=>{
 const {state,jobs}=fixture();const other=vi.fn(()=>true);(jobs as any).threadController={pinNonforcingShutdown(){throw new Error("unconfirmed");}};(jobs as any).recoveryController={pinNonforcingShutdown:other};
 try{expect(()=>jobs.pinNonforcingShutdown()).toThrow("NONFORCING_SHUTDOWN_PIN_UNCONFIRMED");expect(other).toHaveBeenCalledTimes(1);expect(()=>jobs.pinNonforcingShutdown()).toThrow("NONFORCING_SHUTDOWN_PIN_UNCONFIRMED");expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry reentrant unsubscribe cannot observe or acknowledge an unfinished fence",()=>{
 const {state,jobs}=fixture();let observed:any;(jobs as any).unsubscribeRecovery=()=>{observed=jobs.observeNonforcingExit();jobs.pinNonforcingShutdown();};
 try{expect(()=>jobs.pinNonforcingShutdown()).toThrow("NONFORCING_SHUTDOWN_PIN_UNCONFIRMED");expect(observed.outcome).toBe("uncertain");expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry late observation overflow remains bounded and UNKNOWN",async()=>{
 const {state,jobs}=fixture();let progress!:(value:CodexProgress)=>void;let finish!:(value:ToolResult)=>void;const job=jobs.start(input(),async(p)=>{progress=p;return new Promise(r=>{finish=r;});});await Promise.resolve();await Promise.resolve();
 try{jobs.pinNonforcingShutdown();for(let i=0;i<256;i++)progress({progress:i});finish(result);await job.promise;expect((jobs as any).nonforcingLateObservationCount).toBe(128);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry recovery construction is registered before an options getter can pin",()=>{
 const {state,jobs}=fixture();let initial:any;const attempt=vi.fn(async()=>({resolved:true,reason:"unused"}));
 try{jobs.configureAutomaticRecovery({candidates:()=>[],attempt,get now(){jobs.pinNonforcingShutdown();initial=jobs.observeNonforcingExit();return ()=>1000;}});
 expect(initial.outcome).toBe("timeout");expect((jobs as any).recoveryController.observeNonforcingExit().exited).toBe(true);expect((jobs as any).recoveryController.timer).toBeUndefined();expect(attempt).not.toHaveBeenCalled();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test("registry first notification callback pin suppresses later callbacks and retains its active observation",()=>{
 const {state,jobs}=fixture();let initial:any;const later=vi.fn();jobs.subscribeChanges(()=>{jobs.pinNonforcingShutdown();initial=jobs.observeNonforcingExit();});jobs.subscribeChanges(later);
 try{jobs.createAgent({scopeId:randomUUID(),agentName:"retained"});expect(initial.outcome).toBe("timeout");expect(later).not.toHaveBeenCalled();expect(jobs.observeNonforcingExit().exited).toBe(true);}finally{state.close();}
});
test("registry asynchronous notification is unowned and cannot become quiet EXIT",()=>{
 const {state,jobs}=fixture();jobs.subscribeChanges(async()=>{});
 try{jobs.createAgent({scopeId:randomUUID(),agentName:"retained"});jobs.pinNonforcingShutdown();expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");expect((jobs as any).nonforcingLateObservationCount).toBe(1);}finally{state.close();}
});
test.each(["progress","assignment"] as const)("registry malformed %s getter never runs or mutates the original job",async kind=>{
 const {state,jobs}=fixture();let reads=0,finish!:(r:ToolResult)=>void,p!:(p:CodexProgress)=>void,a!:(a:UpstreamWorkerAssignment)=>void;const notification=vi.fn();
 const job=jobs.start(input(),async(progress,assignment)=>{p=progress;a=assignment;return new Promise(r=>{finish=r;});},undefined,30,false,notification);await Promise.resolve();await Promise.resolve();const before=state.listJobs();
 try{if(kind==="progress")p({progress:1,get message(){reads++;return "hidden";}});else a({backendKind:"app-server",workerGeneration:1,get workerId(){reads++;return "hidden";}});jobs.pinNonforcingShutdown();finish(result);await job.promise;expect(reads).toBe(0);expect(notification).not.toHaveBeenCalled();expect(state.listJobs()).toEqual(before);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry result accessor is retained without invocation, journal completion or ACK",async()=>{
 const {state,jobs}=fixture();let reads=0;const ack=vi.fn();jobs.attachUpstream({listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack});
 const job=jobs.start(input(),async()=>({get content(){reads++;return result.content;}}));
 try{await job.promise;jobs.pinNonforcingShutdown();expect(reads).toBe(0);expect(job.status).toBe("running");expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.has(job.jobId)).toBe(true);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry rejected message accessor is retained without invocation or fake terminal write",async()=>{
 const {state,jobs}=fixture();let reads=0;const error=new Error();Object.defineProperty(error,"message",{get(){reads++;return "hidden";}});const job=jobs.start(input(),async()=>{throw error;});
 try{await job.promise;jobs.pinNonforcingShutdown();expect(reads).toBe(0);expect(job.status).toBe("running");expect(state.listJobs()[0].status).toBe("running");expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry completion callback pin retains undo and exact original result",async()=>{
 const {state,jobs}=fixture();const undo=vi.fn();const job=jobs.start(input(),async()=>result,()=>{jobs.pinNonforcingShutdown();return undo;});
 try{await job.promise;expect(undo).not.toHaveBeenCalled();expect(job.status).toBe("running");expect(state.listJobs()[0].status).toBe("running");expect((jobs as any).deferredSettlements.get(job.jobId).kind).toBe("resolved");expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry pinned durable mutation endpoints reject before touching input",()=>{
 const {state,jobs}=fixture();let reads=0;const poisoned=new Proxy({}, {get(){reads++;throw Error("must not inspect");}});
 try{jobs.pinNonforcingShutdown();for(const name of ["createActivity","createAgent","assignAgent","linkAgentThread","beginCancellationOperation","createCancellationIntent"])
 expect(()=>Reflect.apply((jobs as any)[name],jobs,[poisoned])).toThrow("NONFORCING_SHUTDOWN_PINNED");expect(reads).toBe(0);}finally{state.close();}
});
test("registry exception inspection trap cannot replace the original rejection with a fake completion",async()=>{
 const {state,jobs}=fixture();const error=new Proxy(new Error("original"),{getPrototypeOf(){throw new Error("inspection failed");}});const job=jobs.start(input(),async()=>{throw error;});
 try{await job.promise;jobs.pinNonforcingShutdown();expect(job.status).toBe("running");expect((jobs as any).deferredSettlements.get(job.jobId).error).toBe(error);expect(state.listJobs()[0].status).toBe("running");expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
test("registry pin within an activity transaction prevents its commit and remains UNKNOWN",()=>{
 const {state,jobs}=fixture();let initial:any;try{expect(()=>jobs.activityTransaction(()=>{jobs.createAgent({scopeId:randomUUID(),agentName:"uncommitted"});jobs.pinNonforcingShutdown();initial=jobs.observeNonforcingExit();})).toThrow("NONFORCING_SHUTDOWN_PINNED");expect(initial.outcome).toBe("uncertain");expect(state.countAgents()).toBe(0);expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});

test.each([false, Promise.resolve()])("registry unsupported completion return %s never confirms terminal state or ACK",async returned=>{
 const {state,jobs}=fixture();const ack=vi.fn();jobs.attachUpstream({listTools:async()=>({tools:[]}),callTool:async()=>result,close:async()=>{},supportsExecutionRecovery:()=>true,acknowledgeExecution:ack});
 const job=jobs.start(input(),async()=>result,(()=>returned) as any);
 try{await job.promise;jobs.pinNonforcingShutdown();expect(job.status).toBe("running");expect(state.listJobs()[0].status).toBe("running");expect(ack).not.toHaveBeenCalled();expect((jobs as any).deferredSettlements.get(job.jobId).kind).toBe("resolved");expect(jobs.observeNonforcingExit().outcome).toBe("uncertain");}finally{state.close();}
});
