import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { shutdownResult, type ShutdownResult } from "../src/shutdown.js";
import { workerShutdownResult, snapshotWorkerShutdownBinding,
  type WorkerShutdownBinding, type WorkerShutdownSupervisor } from "../src/workerShutdownReceipt.js";
const state=vi.hoisted(()=>({instances:[] as any[], normalCloses:0, falseCloses:0,
  initialize:undefined as Promise<void>|undefined, transport:undefined as ShutdownResult|undefined}));
vi.mock("../src/jsonRpcProcess.js",async original=>({...(await original<any>()), JsonRpcProcess:class {
  identity={pid:80001,processGroupId:80001};exited=false;private pinned=false;
  constructor(readonly options:any){this.identity={pid:80001+state.instances.length,processGroupId:80001+state.instances.length};state.instances.push(this);}
  async start(){return this.identity;}
  async request(method:string){if(this.pinned)throw Error("closed");if(method==="initialize") {
    await state.initialize;return {userAgent:"private-fixture",platformFamily:"unix",platformOs:"test"};
  }return {data:[]};}
  async notify(){if(this.pinned)throw Error("closed");}
  close(policy?:any){if(policy?.allowSigkillEscalation===false){this.pinned=true;state.falseCloses++;
    this.exited=true;this.options.onExit(Error("fixture exit"));return Promise.resolve(state.transport??shutdownResult("exited"));}
    if(this.pinned)throw Error("ordinary cleanup after pin");state.normalCloses++;this.exited=true;
    this.options.onExit(Error("fixture normal exit"));return Promise.resolve();}
  observeNonforcingExit(){return shutdownResult("exited");}
}}));
import { CodexAppServerUpstreamPool, APP_SERVER_CAPABILITIES } from "../src/appServerUpstream.js";
const dependencies={versionProbe:async()=>"99.0.0",protocolProbe:async()=>({compatible:true,missingCore:[],unsupported:{},capabilities:APP_SERVER_CAPABILITIES})};
beforeEach(()=>{state.instances=[];state.normalCloses=0;state.falseCloses=0;state.initialize=undefined;state.transport=undefined;});
afterEach(()=>vi.useRealTimers());
function supervisor(result:ShutdownResult=shutdownResult("exited")) {
  const seen:WorkerShutdownBinding[]=[];
  const capability:WorkerShutdownSupervisor={pinNonforcingShutdown(binding){seen.push(binding);return true;},
    async closeNonforcing(binding){return {binding,result};},async observeNonforcingExit(binding){return {binding,result:shutdownResult("exited")};}};
  return {capability,seen};
}
async function connected(capability?:WorkerShutdownSupervisor,onWorkerProcessExited?:()=>void) {
  const pool=new CodexAppServerUpstreamPool("private-mocked-executable",1,{workerShutdownSupervisor:capability,onWorkerProcessExited},dependencies);
  await pool.listModels();return pool;
}
const policy={allowSigkillEscalation:false as const,graceMs:0};
describe("App Server pool synchronous policy and generation-bound tree evidence",()=>{
  test("parent exit alone cannot approve absence of its tree",async()=>{
    const forcingCallback=vi.fn(),pool=await connected(undefined,forcingCallback);
    const retained=await pool.closeNonforcing(policy);expect(retained.outcome).toBe("uncertain");
    expect(forcingCallback).not.toHaveBeenCalled();expect(state.normalCloses).toBe(0);
    await expect(pool.close()).rejects.toThrow("NONFORCING_SHUTDOWN_UNCONFIRMED");
    expect((await pool.observeNonforcingExit()).outcome).toBe("uncertain");
  });
  test("pins the exact owned worker before transport exit callbacks and before returning",async()=>{
    const s=supervisor(),callback=vi.fn(),pool=await connected(s.capability,callback);
    const source={...policy,graceMs:7};const close=pool.closeNonforcing(source);source.graceMs=999;
    expect(s.seen).toHaveLength(1);expect(Object.isFrozen(s.seen[0])).toBe(true);
    expect(s.seen[0]).toMatchObject({workerId:"app-0",workerGeneration:1,pid:80001,processGroupId:80001});
    expect(snapshotWorkerShutdownBinding(s.seen[0])).toEqual(s.seen[0]);
    expect((await close).exited).toBe(true);expect(callback).not.toHaveBeenCalled();
    expect(state.falseCloses).toBe(1);await pool.close();expect(state.normalCloses).toBe(0);
    expect(pool.closeNonforcing(policy)).toBe(close);
    await expect(pool.listModels()).rejects.toThrow(/closed/);await expect(pool.listTools()).rejects.toThrow(/closed/);
    expect(state.instances).toHaveLength(1);
  });
  test.each(["ownerId","workerId","workerGeneration","pid","processGroupId"] as const)("rejects receipt for another %s",async field=>{
    const s=supervisor();s.capability.closeNonforcing=async binding=>({binding:{...binding,[field]:field==="ownerId"?"9a4ca409-7e09-40ef-9c7d-7cd4a2b7b1e2":field==="workerId"?"app-1":2},result:shutdownResult("exited")});
    const pool=await connected(s.capability);expect((await pool.closeNonforcing(policy)).exited).toBe(false);
    expect(state.normalCloses).toBe(0);
  });
  test("retains timeout receipt while separate observation proves later tree exit",async()=>{
    const s=supervisor(shutdownResult("timeout",1)),pool=await connected(s.capability);
    const retained=await pool.closeNonforcing(policy);expect(retained.outcome).toBe("timeout");
    expect((await pool.observeNonforcingExit()).exited).toBe(true);expect(retained.outcome).toBe("timeout");
  });
  test("void tree completion does not approve exit",async()=>{
    const s=supervisor();s.capability.closeNonforcing=async()=>undefined as never;
    const pool=await connected(s.capability);expect((await pool.closeNonforcing(policy)).outcome).toBe("uncertain");
  });
  test("unresolved tree close is bounded and late success cannot rewrite the receipt",async()=>{
    const s=supervisor();let finish!:(value:any)=>void;s.capability.closeNonforcing=binding=>new Promise(resolve=>{finish=()=>resolve({binding,result:shutdownResult("exited")});});
    const pool=await connected(s.capability);vi.useFakeTimers();const close=pool.closeNonforcing(policy);
    await vi.advanceTimersByTimeAsync(6000);const retained=await close;expect(retained.outcome).toBe("uncertain");
    finish({});await Promise.resolve();expect(retained.outcome).toBe("uncertain");expect(state.normalCloses).toBe(0);
  });
  test("pin failure prevents false tree proof while still pinning transport",async()=>{
    const s=supervisor();s.capability.pinNonforcingShutdown=()=>{throw Error("tree fence unavailable");};
    const tree=vi.spyOn(s.capability,"closeNonforcing"),pool=await connected(s.capability);
    expect((await pool.closeNonforcing(policy)).outcome).toBe("uncertain");expect(tree).not.toHaveBeenCalled();
    expect(state.falseCloses).toBe(1);expect(state.normalCloses).toBe(0);
  });
  test("startup awaiting initialize is pinned before its failure cleanup resumes",async()=>{
    let release!:()=>void;state.initialize=new Promise(resolve=>{release=resolve;});const s=supervisor(),callback=vi.fn();
    const pool=new CodexAppServerUpstreamPool("private-mock",1,{workerShutdownSupervisor:s.capability,onWorkerProcessExited:callback},dependencies);
    const startup=pool.listModels();const rejected=expect(startup).rejects.toThrow(/closed/);
    await vi.waitFor(()=>expect(state.instances).toHaveLength(1));
    expect((await pool.closeNonforcing(policy)).exited).toBe(true);release();await rejected;
    expect(state.normalCloses).toBe(0);expect(callback).not.toHaveBeenCalled();expect(state.instances).toHaveLength(1);
  });
  test("pending owned-tree registration cannot approve an empty tree at close or later observation",async()=>{
    let finish!:()=>void;const registration=new Promise<void>(resolve=>{finish=resolve;});
    const s=supervisor(),started=vi.fn(()=>registration);
    const pool=new CodexAppServerUpstreamPool("private-mock",1,{workerShutdownSupervisor:s.capability,onWorkerProcessStarted:started},dependencies);
    const startup=pool.listModels().then(()=>undefined,error=>error);
    try {
      await vi.waitFor(()=>expect(started).toHaveBeenCalledOnce());
      const retained=await pool.closeNonforcing(policy);expect(retained.outcome).toBe("uncertain");
      expect((await pool.observeNonforcingExit()).outcome).toBe("uncertain");
      finish();expect(await startup).toBeInstanceOf(Error);
      expect((await pool.observeNonforcingExit()).outcome).toBe("uncertain");
      expect(state.normalCloses).toBe(0);expect(retained.outcome).toBe("uncertain");
    } finally {finish();await startup;}
  });
  test("close while executable admission is pending creates no worker",async()=>{
    let release!:(value:string)=>void;const version=new Promise<string>(resolve=>{release=resolve;});
    const pool=new CodexAppServerUpstreamPool("private-mock",1,{}, {...dependencies,versionProbe:()=>version});
    const startup=pool.listModels();const rejected=expect(startup).rejects.toThrow(/closed/);
    await Promise.resolve();await Promise.resolve();const close=pool.closeNonforcing(policy);release("99.0.0");
    await close;await rejected;expect(state.instances).toHaveLength(0);expect(state.normalCloses).toBe(0);
  });
  test("invalid policy accessors and true policy have no shutdown effects",async()=>{
    const pool=await connected();const getter=vi.fn(()=>false);
    expect(()=>pool.closeNonforcing(Object.defineProperty({},"allowSigkillEscalation",{get:getter}) as never)).toThrow("SHUTDOWN_POLICY_INVALID");
    expect(getter).not.toHaveBeenCalled();expect(()=>pool.closeNonforcing({allowSigkillEscalation:true} as never)).toThrow("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    await pool.listModels();await pool.close();expect(state.falseCloses).toBe(0);expect(state.normalCloses).toBe(1);
  });
  test("ordinary close already started remains unknown after later pin",async()=>{
    const s=supervisor(),pool=await connected(s.capability);const ordinary=pool.close();const result=await pool.closeNonforcing(policy);
    await ordinary;expect(result.outcome).toBe("uncertain");expect((await pool.observeNonforcingExit()).outcome).toBe("uncertain");
  });
  test("an exit callback queued before pin rechecks the decision before starting ordinary cleanup",async()=>{
    const s=supervisor(),callback=vi.fn(),pool=await connected(s.capability,callback);
    state.instances[0].exited=true;state.instances[0].options.onExit(Error("private queued exit"));
    expect((await pool.closeNonforcing(policy)).exited).toBe(true);expect(callback).not.toHaveBeenCalled();
  });
  test("an ordinary exit cleanup already running cannot certify a nonforcing history",async()=>{
    const s=supervisor(),callback=vi.fn(()=>new Promise<void>(()=>{})),pool=await connected(s.capability,callback);
    state.instances[0].exited=true;state.instances[0].options.onExit(Error("private prior exit"));
    await Promise.resolve();expect(callback).toHaveBeenCalledOnce();
    expect((await pool.closeNonforcing(policy)).outcome).toBe("uncertain");
    expect((await pool.observeNonforcingExit()).outcome).toBe("uncertain");
  });
  test("ordinary close reentered by a synchronous tree fence never force-closes the transport",async()=>{
    const s=supervisor();let reentrant:Promise<void>|undefined;let pool!:CodexAppServerUpstreamPool;
    s.capability.pinNonforcingShutdown=()=>{reentrant=pool.close();return true;};
    pool=await connected(s.capability);await pool.closeNonforcing(policy);await reentrant;expect(state.normalCloses).toBe(0);
  });
  test("each pool uses a distinct owner even with identical synthetic PID and generation",async()=>{
    const a=supervisor(),p=await connected(a.capability);await p.closeNonforcing(policy);
    state.instances=[];const b=supervisor(),q=await connected(b.capability);await q.closeNonforcing(policy);
    expect(a.seen[0].ownerId).not.toBe(b.seen[0].ownerId);
  });
});
describe("worker receipt exact data envelope",()=>{
  const binding:WorkerShutdownBinding={ownerId:"9a4ca409-7e09-40ef-9c7d-7cd4a2b7b1e2",workerId:"app-0",workerGeneration:1,pid:2,processGroupId:2};
  test.each([undefined,null,{},Object.assign({binding,result:shutdownResult("exited")},{extra:1}),
    {[Symbol("hidden")]:true,binding,result:shutdownResult("exited")},
    {binding:Object.assign({},binding,{extra:1}),result:shutdownResult("exited")},
    {binding,result:{...shutdownResult("exited"),survivors:1}},
    Object.create({binding,result:shutdownResult("exited")})])("rejects malformed or inherited receipt %s",value=>{
    expect(workerShutdownResult(value,binding).outcome).toBe("uncertain");
  });
  test("does not invoke getters in receipt, binding or result",()=>{
    for(const field of ["receipt","binding","result"]){const getter=vi.fn(()=>true);let receipt:any={binding,result:shutdownResult("exited")};
      if(field==="receipt")Object.defineProperty(receipt,"result",{get:getter});
      else if(field==="binding")receipt.binding=Object.defineProperty({...binding},"pid",{get:getter});
      else receipt.result=Object.defineProperty({...shutdownResult("exited")},"exited",{get:getter});
      expect(workerShutdownResult(receipt,binding).outcome).toBe("uncertain");expect(getter).not.toHaveBeenCalled();}
  });
});
