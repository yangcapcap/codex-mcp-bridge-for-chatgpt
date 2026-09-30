import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexBackendRouter } from "../src/upstreamRouter.js";
import type { CodexUpstream } from "../src/upstream.js";
import { shutdownResult, type ShutdownResult } from "../src/shutdown.js";

function fixture() {
  const close=vi.fn(async()=>{}),callTool=vi.fn(async()=>({content:[]})),listTools=vi.fn(async()=>[]);
  const backend:CodexUpstream={close,callTool,listTools};
  return {backend,close,callTool,listTools,router:new CodexBackendRouter("app-server",backend)};
}
afterEach(()=>vi.useRealTimers());
describe("router explicit nonforcing capability and receipt boundaries",()=> {
  test("missing capability is uncertain and never falls back to forcing close",async()=> {
    const f=fixture();f.router.bindThread("old","app-server");
    expect((await f.router.closeNonforcing({allowSigkillEscalation:false})).outcome).toBe("uncertain");
    await expect(f.router.close()).rejects.toThrow("NONFORCING_SHUTDOWN_UNCONFIRMED");
    expect(f.close).not.toHaveBeenCalled();
    await expect(f.router.callTool("codex",{prompt:"new"})).rejects.toThrow(/closed/);
    await expect(f.router.listTools()).rejects.toThrow(/closed/);expect(f.callTool).not.toHaveBeenCalled();
    expect(f.listTools).not.toHaveBeenCalled();
  });
  test("passes a single immutable policy with the actual backend receiver before returning",async()=> {
    const f=fixture();let invoked=false;
    f.backend.closeNonforcing=function(policy) {
      invoked=true;expect(this).toBe(f.backend);expect(Object.isFrozen(policy)).toBe(true);
      expect(policy).toEqual({allowSigkillEscalation:false,graceMs:7});return Promise.resolve(shutdownResult("exited"));
    };
    const source={allowSigkillEscalation:false as const,graceMs:7};const close=f.router.closeNonforcing(source);
    expect(invoked).toBe(true);source.graceMs=99;
    expect((await close).exited).toBe(true);await f.router.close();expect(f.close).not.toHaveBeenCalled();
  });
  test.each([undefined,{exited:true},Object.assign(shutdownResult("timeout",1),{})])("does not infer success from invalid or survivor evidence: %s",async value=> {
    const f=fixture();f.backend.closeNonforcing=async()=>value as ShutdownResult;
    expect((await f.router.closeNonforcing({allowSigkillEscalation:false})).exited).toBe(false);
  });
  test("capability getter errors and synchronous throws are uncertain",async()=> {
    for(const getter of [true,false]) {
      const f=fixture();
      if(getter) Object.defineProperty(f.backend,"closeNonforcing",{get(){throw Error("lookup fault");}});
      else f.backend.closeNonforcing=()=>{throw Error("operation fault");};
      expect((await f.router.closeNonforcing({allowSigkillEscalation:false})).outcome).toBe("uncertain");
      expect(f.close).not.toHaveBeenCalled();
    }
  });
  test("invalid accessor policy is rejected before any capability lookup or state effect",async()=> {
    const f=fixture(),lookup=vi.fn();
    Object.defineProperty(f.backend,"closeNonforcing",{get:lookup});
    expect(()=>f.router.closeNonforcing(Object.defineProperty({},"allowSigkillEscalation",{
      get(){throw Error("should not evaluate");}
    }) as never)).toThrow("SHUTDOWN_POLICY_INVALID");
    expect(lookup).not.toHaveBeenCalled();await f.router.close();expect(f.close).toHaveBeenCalledOnce();
  });
  test("true policy cannot enter the explicit nonforcing path",async()=> {
    const f=fixture();expect(()=>f.router.closeNonforcing({allowSigkillEscalation:true} as never))
      .toThrow("NONFORCING_SHUTDOWN_POLICY_REQUIRED");await f.router.close();expect(f.close).toHaveBeenCalledOnce();
  });
  test("reentrant ordinary close cannot independently force after policy was pinned",async()=> {
    const f=fixture();let reentrant:Promise<void>|undefined;
    f.backend.closeNonforcing=()=>{reentrant=f.router.close();return Promise.resolve(shutdownResult("exited"));};
    await f.router.closeNonforcing({allowSigkillEscalation:false});await reentrant;expect(f.close).not.toHaveBeenCalled();
  });
  test("an unresolved capability is bounded and its late success cannot rewrite the sealed result",async()=> {
    vi.useFakeTimers();const f=fixture();let finish!:(value:ShutdownResult)=>void;
    f.backend.closeNonforcing=()=>new Promise(resolve=>{finish=resolve;});
    const close=f.router.closeNonforcing({allowSigkillEscalation:false,graceMs:0});
    await vi.advanceTimersByTimeAsync(6000);const retained=await close;
    expect(retained.outcome).toBe("uncertain");finish(shutdownResult("exited"));await Promise.resolve();
    expect(retained.outcome).toBe("uncertain");expect(f.close).not.toHaveBeenCalled();
  });
  test("a separate fresh observation can resolve a retained timeout",async()=> {
    const f=fixture();f.backend.closeNonforcing=async()=>shutdownResult("timeout",1);
    f.backend.observeNonforcingExit=()=>shutdownResult("exited");
    const retained=await f.router.closeNonforcing({allowSigkillEscalation:false});
    expect((await f.router.observeNonforcingExit()).exited).toBe(true);expect(retained.outcome).toBe("timeout");
  });
  test("no observation capability or unrequested observation grants no exit proof",async()=> {
    const f=fixture();expect((await f.router.observeNonforcingExit()).outcome).toBe("uncertain");
    f.backend.closeNonforcing=async()=>shutdownResult("exited");await f.router.closeNonforcing({allowSigkillEscalation:false});
    expect((await f.router.observeNonforcingExit()).outcome).toBe("uncertain");
  });
  test("ordinary shutdown already started remains uncertain despite later supplied exit receipts",async()=> {
    const f=fixture();await f.router.close();
    f.backend.closeNonforcing=async()=>shutdownResult("exited");f.backend.observeNonforcingExit=()=>shutdownResult("exited");
    expect((await f.router.closeNonforcing({allowSigkillEscalation:false})).outcome).toBe("uncertain");
    expect((await f.router.observeNonforcingExit()).outcome).toBe("uncertain");expect(f.close).toHaveBeenCalledOnce();
  });
});
