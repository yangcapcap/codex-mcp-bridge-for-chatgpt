import {describe, expect, it, vi} from "vitest";
import {BridgeStateStore} from "../src/stateStore.js";
import {AutomaticRecoveryController, automaticRecoveryKey} from "../src/automaticRecovery.js";
import {ThreadConnectionController} from "../src/threadConnections.js";
import {StateMaintenanceScheduler} from "../src/maintenanceScheduler.js";
import type {OperationalStateService, OperationalStateResult} from "../src/stateService.js";
import type {CodexUpstream} from "../src/upstream.js";

function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;});return {promise,resolve};}
const candidate = {key: automaticRecoveryKey("recheck",["pin",1]),scopeId:"scope-a",agentId:"agent-a",kind:"recheck" as const};

describe("state background nonforcing fences",()=>{
  it("keeps an in-flight recovery attempt unconfirmed after its late success",async()=>{
    const state=new BridgeStateStore({file:":memory:"});const done=deferred<{resolved:boolean;reason:string;evidence:string}>();
    const started=deferred<void>();const changed=vi.fn();
    const owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[candidate],changed,
      attempt:()=>{started.resolve();return done.promise;},now:()=>1000});
    try {
      const running=owner.sweep();await started.promise;
      const original=state.automaticRecovery.get(candidate.key);expect(original).toMatchObject({state:"retrying",attempts:1});
      expect(owner.pinNonforcingShutdown()).toBe(true);
      expect(owner.observeNonforcingExit()).toMatchObject({outcome:"timeout",survivors:1});
      const notifications=changed.mock.calls.length;
      done.resolve({resolved:true,reason:"late-confirmation",evidence:"runtime-observed"});await running;
      expect(state.automaticRecovery.get(candidate.key)).toEqual(original);
      expect(changed.mock.calls.length).toBe(notifications);
      expect(owner.observeNonforcingExit()).toMatchObject({exited:true});
      await owner.recoverJob("ignored");await owner.sweep();
      expect(state.automaticRecovery.get(candidate.key)).toEqual(original);
    }finally{await owner.close();state.close();}
  });
  it("does not reconcile obsolete recovery records after discovery resumes past a pin",async()=>{
    const state=new BridgeStateStore({file:":memory:"});const discovered=deferred<typeof candidate[]>();
    const attempt=vi.fn();const owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>discovered.promise,attempt});
    try{
      state.automaticRecovery.begin(candidate,1000);const original=state.automaticRecovery.get(candidate.key);
      const running=owner.sweep();owner.pinNonforcingShutdown();discovered.resolve([]);await running;
      expect(state.automaticRecovery.get(candidate.key)).toEqual(original);expect(attempt).not.toHaveBeenCalled();
      expect(owner.observeNonforcingExit().exited).toBe(true);
    }finally{await owner.close();state.close();}
  });
  it("retains the scheduled recovery identities without executing a queued callback",async()=>{
    vi.useFakeTimers();const state=new BridgeStateStore({file:":memory:"});const discover=vi.fn(()=>[]);
    const owner=new AutomaticRecoveryController(state.automaticRecovery,{candidates:discover,attempt:async()=>({resolved:false,reason:"unused"})});
    try{
      owner.schedule("exact-agent");owner.pinNonforcingShutdown();await vi.advanceTimersByTimeAsync(1000);
      expect(discover).not.toHaveBeenCalled();
      expect((owner as unknown as {scheduledAgents:Set<string>}).scheduledAgents).toEqual(new Set(["exact-agent"]));
      expect(owner.observeNonforcingExit().exited).toBe(true);
    }finally{await owner.close();state.close();vi.useRealTimers();}
  });
  it("retains the original releasing connection instead of publishing late evidence",async()=>{
    const state=new BridgeStateStore({file:":memory:"});const done=deferred<{phase:"released";evidence:"worker-exited"}>();const started=deferred<void>();
    state.threadConnections.register({threadId:"owned-thread",scopeId:"scope-a",persistence:"persistent"});state.threadConnections.requestHandoff("owned-thread");
    const owner=new ThreadConnectionController(state.threadConnections,{releaseThreadConnection:()=>{started.resolve();return done.promise;}} as unknown as CodexUpstream);
    try{
      const running=owner.sweep();await started.promise;const original=state.threadConnections.get("owned-thread");
      expect(original?.phase).toBe("releasing");owner.pinNonforcingShutdown();expect(owner.observeNonforcingExit().outcome).toBe("timeout");
      done.resolve({phase:"released",evidence:"worker-exited"});await running;
      expect(state.threadConnections.get("owned-thread")).toEqual(original);expect(owner.observeNonforcingExit().exited).toBe(true);
      expect(()=>owner.cancel("owned-thread")).toThrow("NONFORCING_SHUTDOWN_PINNED");
      expect(()=>owner.request("owned-thread")).toThrow("NONFORCING_SHUTDOWN_PINNED");
    }finally{await owner.close();state.close();}
  });
  it("retains a maintenance command identity and suppresses its late registry callback",async()=>{
    const done=deferred<OperationalStateResult>();const completed=vi.fn();const changed=vi.fn();let id:string|undefined;
    const owner=new StateMaintenanceScheduler({execute:(_command:unknown,options:{commandId:string})=>{id=options.commandId;return done.promise;}} as unknown as OperationalStateService,{completed,changed});
    const running=owner.sweep("events");owner.pinNonforcingShutdown();
    expect(owner.observeNonforcingExit().outcome).toBe("uncertain");
    done.resolve({changed:2} as OperationalStateResult);await running;
    const records=(owner as unknown as {uncertainCommands:Map<string,{commandId:string}>}).uncertainCommands;
    expect(records.get("events")?.commandId).toBe(id);expect(completed).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
    expect(owner.observeNonforcingExit().outcome).toBe("uncertain");owner.close();expect(records.get("events")?.commandId).toBe(id);
  });
  it("does not dispatch a maintenance operation when command construction pins",async()=>{
    const execute=vi.fn();let owner!:StateMaintenanceScheduler;
    owner=new StateMaintenanceScheduler({execute} as unknown as OperationalStateService,{command:()=>{owner.pinNonforcingShutdown();return {operation:"maintain",slice:"events"};}});
    await owner.sweep("events");expect(execute).not.toHaveBeenCalled();expect(owner.observeNonforcingExit().exited).toBe(true);
  });
  it("does not invoke a maintenance completed callback returned by a pinning getter",async()=>{
    const callback=vi.fn();let owner!:StateMaintenanceScheduler;
    const options={get completed(){owner.pinNonforcingShutdown();return callback;}};
    owner=new StateMaintenanceScheduler({execute:async()=>({changed:1})} as unknown as OperationalStateService,options);
    await owner.sweep("events");expect(callback).not.toHaveBeenCalled();expect(owner.observeNonforcingExit().outcome).toBe("uncertain");
  });
  it("reports ordinary-close history as unknown across repeated pins for every controller",async()=>{
    const state=new BridgeStateStore({file:":memory:"});
    const recovery=new AutomaticRecoveryController(state.automaticRecovery,{candidates:()=>[],attempt:async()=>({resolved:false,reason:"unused"})});
    const thread=new ThreadConnectionController(state.threadConnections,{} as CodexUpstream);
    const maintenance=new StateMaintenanceScheduler({} as OperationalStateService);
    try{
      await recovery.close();await thread.close();maintenance.close();
      for(const owner of [recovery,thread,maintenance]){owner.pinNonforcingShutdown();owner.pinNonforcingShutdown();expect(owner.observeNonforcingExit().outcome).toBe("uncertain");}
    }finally{state.close();}
  });
});
