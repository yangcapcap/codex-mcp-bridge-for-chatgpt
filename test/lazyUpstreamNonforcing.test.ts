import {afterEach,expect,test,vi} from "vitest";
import {LazyCodexUpstream} from "../src/lazyUpstream.js";
import {shutdownResult} from "../src/shutdown.js";
const policy={allowSigkillEscalation:false as const,graceMs:0};
const features={} as any;
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
function backend(){return {listTools:vi.fn(async()=>({})),callTool:vi.fn(async()=>({})),startThread:vi.fn(async()=>({})),forceTerminateWorker:vi.fn(async()=>({})),close:vi.fn(async()=>{}),closeNonforcing:vi.fn(async()=>shutdownResult("exited")),observeNonforcingExit:vi.fn(async()=>shutdownResult("exited"))};}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
test("never-started lazy backend closes without calling its factory or ordinary disposer",async()=>{
 const factory=vi.fn(async()=>backend() as any);const lazy=new LazyCodexUpstream("app-server",features,factory);
 expect((await lazy.closeNonforcing(policy)).exited).toBe(true);expect(factory).not.toHaveBeenCalled();expect((await lazy.observeNonforcingExit()).exited).toBe(true);
 await expect(lazy.startThread({} as any)).rejects.toThrow("closed");await lazy.close();
});
test("existing backend pins synchronously and preserves original TIMEOUT after a fresh observation",async()=>{
 const b=backend();b.closeNonforcing.mockResolvedValue(shutdownResult("timeout",1));const lazy=new LazyCodexUpstream("app-server",features,async()=>b as any);
 await lazy.callTool({} as any);const close=lazy.closeNonforcing(policy);expect(b.closeNonforcing).toHaveBeenCalledTimes(1);
 const original=await close;expect(original.outcome).toBe("timeout");expect((await lazy.observeNonforcingExit()).exited).toBe(true);expect(original.outcome).toBe("timeout");
 await expect(lazy.close()).rejects.toThrow("UNCONFIRMED");expect(b.close).not.toHaveBeenCalled();
});
test("unfinished factory stays UNKNOWN and late instance is fenced before admission resumes",async()=>{
 const pending=deferred<any>(),b=backend(),pin=vi.fn(()=>true as const);const lazy=new LazyCodexUpstream("app-server",features,()=>pending.promise,undefined,undefined,pin);
 const request=lazy.startThread({} as any).catch(error=>error);await Promise.resolve();const close=lazy.closeNonforcing(policy);expect(pin).toHaveBeenCalledTimes(1);
 pending.resolve(b);expect((await request).message).toContain("closed");expect((await close).outcome).toBe("uncertain");expect((await lazy.observeNonforcingExit()).outcome).toBe("uncertain");
 expect(b.closeNonforcing).toHaveBeenCalledTimes(1);expect(b.startThread).not.toHaveBeenCalled();expect(b.close).not.toHaveBeenCalled();
});
test("an ordinary close awaiting a factory cannot resume force or disposal after pin",async()=>{
 const pending=deferred<any>(),b=backend(),dispose=vi.fn(async()=>{});const lazy=new LazyCodexUpstream("app-server",features,()=>pending.promise,dispose);
 const request=lazy.startThread({} as any).catch(error=>error);await Promise.resolve();const ordinary=lazy.close().catch(error=>error);const close=lazy.closeNonforcing(policy);pending.resolve(b);
 await request;expect((await close).outcome).toBe("uncertain");expect((await ordinary).message).toContain("UNCONFIRMED");expect(b.close).not.toHaveBeenCalled();expect(dispose).not.toHaveBeenCalled();
});
test("an admission guard returning after pin cannot call the previously captured backend method",async()=>{
 const guard=deferred<void>(),b=backend();const lazy=new LazyCodexUpstream("app-server",features,async()=>b as any,undefined,()=>guard.promise);
 const request=lazy.startThread({} as any).catch(error=>error);await Promise.resolve();await Promise.resolve();await Promise.resolve();
 const close=lazy.closeNonforcing(policy);guard.resolve();expect((await request).message).toContain("closed");await close;expect(b.startThread).not.toHaveBeenCalled();
});
test("missing receipt capability never falls back to ordinary close",async()=>{
 const b=backend();delete (b as any).closeNonforcing;const lazy=new LazyCodexUpstream("app-server",features,async()=>b as any);await lazy.callTool({} as any);
 expect((await lazy.closeNonforcing(policy)).outcome).toBe("uncertain");await expect(lazy.close()).rejects.toThrow("UNCONFIRMED");expect(b.close).not.toHaveBeenCalled();expect((await lazy.observeNonforcingExit()).outcome).toBe("uncertain");
});
test("pending construction deadline retains UNKNOWN and fences a late instance without losing resume protections",async()=>{
 vi.useFakeTimers();const pending=deferred<any>(),b={...backend(),protectThreadFromImplicitResume:vi.fn()};const lazy=new LazyCodexUpstream("app-server",features,()=>pending.promise);
 lazy.protectThreadFromImplicitResume("thread-retained");const request=lazy.startThread({} as any).catch(error=>error);await Promise.resolve();const close=lazy.closeNonforcing(policy);
 await vi.advanceTimersByTimeAsync(6100);expect((await close).outcome).toBe("uncertain");pending.resolve(b);await request;
 expect(b.closeNonforcing).toHaveBeenCalledTimes(1);expect(b.protectThreadFromImplicitResume).not.toHaveBeenCalled();expect((lazy as any).pendingResumeProtections.has("thread-retained")).toBe(true);
});
test("prior ordinary close remains UNKNOWN even after later zero-resource proof",async()=>{
 const b=backend();const lazy=new LazyCodexUpstream("app-server",features,async()=>b as any);await lazy.callTool({} as any);await lazy.close();
 expect((await lazy.closeNonforcing(policy)).outcome).toBe("uncertain");expect((await lazy.observeNonforcingExit()).outcome).toBe("uncertain");expect(b.close).toHaveBeenCalledTimes(1);
});
test("unrequested ordinary lazy close retains normal backend close and disposer behavior",async()=>{
 const b=backend(),dispose=vi.fn(async()=>{});const lazy=new LazyCodexUpstream("app-server",features,async()=>b as any,dispose);await lazy.callTool({} as any);await lazy.close();
 expect(b.close).toHaveBeenCalledTimes(1);expect(dispose).toHaveBeenCalledTimes(1);expect(b.closeNonforcing).not.toHaveBeenCalled();
});

test("factory reentrancy sees an already sealed construction and cannot approve absence",async()=>{
 const b=backend();let close:Promise<any>|undefined;
 const lazy=new LazyCodexUpstream("app-server",features,async()=>{close=lazy.closeNonforcing(policy);return b as any;});
 await expect(lazy.startThread({} as any)).rejects.toThrow("closed");expect((await close!).outcome).toBe("uncertain");
 expect(b.closeNonforcing).toHaveBeenCalledTimes(1);expect(b.startThread).not.toHaveBeenCalled();
});
