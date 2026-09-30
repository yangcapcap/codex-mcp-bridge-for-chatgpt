import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JsonRpcProcess } from "../src/jsonRpcProcess.js";
import { shutdownResult } from "../src/shutdown.js";

class FakeChild extends EventEmitter {
  pid=999_999_991;
  exitCode: number|null=null;
  signalCode: NodeJS.Signals|null=null;
  stdin={end:vi.fn(),write:vi.fn()};
  kill=vi.fn((_signal: NodeJS.Signals)=>true);
}
function transport() {
  const rpc=new JsonRpcProcess({command:"unused",args:[],debugLabel:"synthetic"});
  const child=new FakeChild();
  const state=rpc as unknown as {child:ChildProcessWithoutNullStreams;closing:boolean;
    exitPromise:Promise<void>;failWire:(error:Error)=>void};
  state.child=child as unknown as ChildProcessWithoutNullStreams;
  state.exitPromise=new Promise(()=>{});
  const probe=vi.spyOn(process,"kill").mockImplementation((_pid,signal)=>{
    if (signal===0) return true;
    throw Error("unexpected signal");
  });
  return {rpc,child,state,probe};
}
afterEach(()=>vi.restoreAllMocks());
describe("explicit nonforcing JSON-RPC close", () => {
  test("returns bounded survivors, pins the decision and blocks later escalation/new RPC", async () => {
    const {rpc,child,probe}=transport();
    const first=rpc.close({allowSigkillEscalation:false,graceMs:1});
    const forced=rpc.forceTerminate(1);
    expect(await first).toEqual(shutdownResult("timeout",1));
    expect(await forced).toMatchObject({exited:false,escalated:false,signal:null});
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(probe.mock.calls.every(call=>call[1]===0)).toBe(true);
    await expect(rpc.start()).rejects.toThrow(/closed/);
    await expect(rpc.request("new")).rejects.toThrow(/closed/);
    await expect(rpc.notify("new")).rejects.toThrow(/closed/);
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(await rpc.close(1)).toEqual(shutdownResult("timeout",1));
  });
  test("observed parent exit does not prove original group absence", async () => {
    const {rpc,child}=transport(); child.exitCode=0;
    expect(await rpc.close({allowSigkillEscalation:false,graceMs:0})).toEqual(shutdownResult("timeout",1));
    expect(rpc.observeNonforcingExit()).toEqual(shutdownResult("timeout",1));
    expect(child.kill).not.toHaveBeenCalled();
  });
  test("requires ESRCH and parent exit, and preserves sealed timeout on later observation", async () => {
    const {rpc,child,probe}=transport();
    const receipt=await rpc.close({allowSigkillEscalation:false,graceMs:0});
    probe.mockImplementation(()=>{throw Object.assign(Error("gone"),{code:"ESRCH"});});
    expect(rpc.observeNonforcingExit().outcome).toBe("uncertain");
    child.exitCode=0;
    expect(rpc.observeNonforcingExit()).toEqual(shutdownResult("exited"));
    expect(receipt).toEqual(shutdownResult("timeout",1));
    expect(await rpc.close({allowSigkillEscalation:false})).toBe(receipt);
  });
  test.each(["EPERM","EACCES",undefined])("probe %s remains uncertain and sends no termination signal", async code => {
    const {rpc,child,probe}=transport(); probe.mockImplementation(()=>{throw Object.assign(Error("unknown"),{code});});
    expect((await rpc.close({allowSigkillEscalation:false,graceMs:0})).outcome).toBe("uncertain");
    expect(child.kill).not.toHaveBeenCalled();
  });
  test("false probe result is unknown", async () => {
    const {rpc,child,probe}=transport(); probe.mockReturnValue(false);
    expect((await rpc.close({allowSigkillEscalation:false,graceMs:0})).outcome).toBe("uncertain");
    expect(child.kill).not.toHaveBeenCalled();
  });
  test("successful owned-child TERM still requires actual exit and group absence", async () => {
    const {rpc,child,probe}=transport();
    child.kill.mockImplementation(()=>{child.signalCode="SIGTERM";
      probe.mockImplementation(()=>{throw Object.assign(Error("gone"),{code:"ESRCH"});}); return true;});
    expect(await rpc.close({allowSigkillEscalation:false,graceMs:0})).toEqual(shutdownResult("exited"));
  });
  test("signal failure remains uncertain even if exit later becomes visible", async () => {
    const {rpc,child,probe}=transport();
    child.kill.mockImplementation(()=>{child.exitCode=0;
      probe.mockImplementation(()=>{throw Object.assign(Error("gone"),{code:"ESRCH"});}); return false;});
    expect(await rpc.close({allowSigkillEscalation:false,graceMs:0})).toEqual(shutdownResult("uncertain",0,1));
  });
  test("retains original handle and refuses changed identity", async () => {
    const {rpc,child}=transport(); child.stdin.end.mockImplementation(()=>{child.pid++;});
    expect(await rpc.close({allowSigkillEscalation:false,graceMs:0})).toEqual(shutdownResult("uncertain",1,0,1));
    expect(child.kill).not.toHaveBeenCalled();
  });
  test("preexisting default close cannot turn into a clean nonforcing receipt", async () => {
    const {rpc,child,state}=transport(); state.closing=true;
    expect(await rpc.close({allowSigkillEscalation:false,graceMs:0})).toEqual(shutdownResult("uncertain",1));
    expect(rpc.observeNonforcingExit().outcome).toBe("uncertain");
    expect(child.kill).not.toHaveBeenCalled();
  });
  test("invalid opt-in policy changes nothing", async () => {
    const {rpc,child,state}=transport();
    await expect(rpc.close({allowSigkillEscalation:false,graceMs:NaN})).rejects.toThrow(/POLICY/);
    expect(state.closing).toBe(false); expect(child.stdin.end).not.toHaveBeenCalled();
  });
  test("an accessor cannot change the explicit prohibition between validation and close", async () => {
    const {rpc,child,state}=transport(); let reads=0;
    const policy={graceMs:0,get allowSigkillEscalation(){return ++reads>1;}};
    await expect(rpc.close(policy)).rejects.toThrow(/POLICY/);
    expect(reads).toBe(0);expect(state.closing).toBe(false);expect(child.stdin.end).not.toHaveBeenCalled();
  });
  test("a nonstarted transport can be closed without claiming any child was killed", async () => {
    const rpc=new JsonRpcProcess({command:"unused",args:[],debugLabel:"synthetic"});
    expect(await rpc.close({allowSigkillEscalation:false})).toEqual(shutdownResult("exited"));
    expect(rpc.observeNonforcingExit()).toEqual(shutdownResult("exited"));
    await expect(rpc.start()).rejects.toThrow(/closed/);
  });
  test.each(["force", "wire"])("pins against an already-running %s escalation continuation", async kind => {
    const {rpc,state,probe}=transport(); probe.mockReturnValue(true);
    let force:Promise<unknown>|undefined;
    if (kind === "force") force=rpc.forceTerminate(1);
    else state.failWire(Error("invalid synthetic wire"));
    expect(await rpc.close({allowSigkillEscalation:false,graceMs:0})).toEqual(shutdownResult("uncertain",1));
    if (force) await force;
    else await new Promise(resolve=>setTimeout(resolve,1525));
    expect(probe.mock.calls.filter(call=>call[1]!==0).map(call=>call[1])).toEqual(["SIGTERM"]);
  });
  test("does not let a default close already waiting for EOF escalate after the decision is pinned", async () => {
    const {rpc,child}=transport();
    const ordinary=rpc.close(1);
    expect(await rpc.close({allowSigkillEscalation:false,graceMs:0})).toEqual(shutdownResult("uncertain",1));
    await ordinary; expect(child.kill).not.toHaveBeenCalled();
  });
  test("default force recovery still escalates when no nonforcing decision was made", async () => {
    const {rpc,probe}=transport(); probe.mockReturnValue(true);
    expect(await rpc.forceTerminate(0)).toMatchObject({exited:false,escalated:true,signal:"SIGKILL"});
    expect(probe.mock.calls.filter(call=>call[1]!==0).map(call=>call[1])).toEqual(["SIGTERM","SIGKILL"]);
  });
});
