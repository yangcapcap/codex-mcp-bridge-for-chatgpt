import { describe, expect, test, vi } from "vitest";
import { SupervisedProcessTreeRegistry } from "../src/processTreeSupervisor.js";

const root = { pid: 999_920, parentPid: 1, processGroupId: 999_920, state: "S", startedAt: "root birth" };
const child = { pid: 999_921, parentPid: root.pid, processGroupId: 999_921, state: "S", startedAt: "child birth" };
const identity = { pid: root.pid, processGroupId: root.processGroupId };
function fixture() {
  let rows: Array<typeof root | Omit<typeof root,"startedAt"> & {startedAt?:string}> = [root,child];
  const registry = new SupervisedProcessTreeRegistry(async () => rows);
  return { registry, setRows: (value: typeof rows) => {rows=value;} };
}

describe.skipIf(process.platform === "win32")("nonforcing supervised tree fence and fresh observation", () => {
  test("parent absence never proves exit while a retained escaped child survives", async () => {
    const f=fixture();await f.registry.register(identity);f.registry.pinNonforcingShutdown();
    f.registry.markExited(identity);f.setRows([{...child,parentPid:1}]);
    const signal=vi.spyOn(process,"kill");
    try {
      const retained=await f.registry.observeNonforcingExit();
      expect(retained).toEqual({exited:false,outcome:"timeout",survivors:1,signalFailures:0,identityChanges:0});
      expect(await f.registry.release(identity,0)).toBe(false);
      expect(await f.registry.cleanupAll(0)).toBe(false);
      f.registry.forget(identity);expect(f.registry.size).toBe(1);
      f.setRows([]);expect((await f.registry.observeNonforcingExit()).exited).toBe(true);
      expect(retained.outcome).toBe("timeout");expect(f.registry.size).toBe(1);
      expect(f.registry.snapshots()[0].processes).toHaveLength(2);
      expect(signal).not.toHaveBeenCalled();
    } finally {signal.mockRestore();}
  });
  test.each(["missing-birth","different-birth","different-group"])("retains uncertainty for %s", async kind => {
    const f=fixture();await f.registry.register(identity);f.registry.pinNonforcingShutdown();f.registry.markExited(identity);
    f.setRows([{...child,parentPid:1,...(kind==="missing-birth" ? {startedAt:undefined} :
      kind==="different-birth" ? {startedAt:"new child birth"} : {processGroupId:999_929})}]);
    const result=await f.registry.observeNonforcingExit();
    expect(result.exited).toBe(false);expect(result.outcome).toBe("uncertain");
    expect(f.registry.snapshots()[0].processes.find(p=>p.pid===child.pid)?.startedAt).toBe(child.startedAt);
  });
  test("does not certify missing unregistered root identity without actual exit evidence", async () => {
    const f=fixture();f.registry.remember(identity,true);f.registry.pinNonforcingShutdown();f.setRows([]);
    expect((await f.registry.observeNonforcingExit()).outcome).toBe("uncertain");
    f.registry.markExited(identity);expect((await f.registry.observeNonforcingExit()).exited).toBe(true);
  });
  test("does not treat a populated old numeric group as verified absence", async () => {
    const f=fixture();await f.registry.register(identity);f.registry.pinNonforcingShutdown();f.registry.markExited(identity);
    f.setRows([{...root,pid:999_928,startedAt:"unrelated birth"}]);
    expect(await f.registry.observeNonforcingExit()).toMatchObject({exited:false,outcome:"uncertain",survivors:1});
  });
  test("pins before a queued ordinary release starts and sends no signal", async () => {
    const f=fixture();await f.registry.register(identity);
    const signal=vi.spyOn(process,"kill").mockImplementation(()=>true);
    try {
      const release=f.registry.release(identity,0);f.registry.pinNonforcingShutdown();
      expect(await release).toBe(false);expect(signal).not.toHaveBeenCalled();
    } finally {signal.mockRestore();}
  });
  test("pins an already running ordinary cleanup before its SIGKILL continuation", async () => {
    const f=fixture();await f.registry.register(identity);
    const signal=vi.spyOn(process,"kill").mockImplementation((_pid, kind)=> {
      if(kind==="SIGTERM") f.registry.pinNonforcingShutdown();return true;
    });
    try {
      expect(await f.registry.release(identity,0)).toBe(false);
      expect(signal.mock.calls.some(([,kind])=>kind==="SIGTERM")).toBe(true);
      expect(signal.mock.calls.some(([,kind])=>kind==="SIGKILL")).toBe(false);
      expect((await f.registry.observeNonforcingExit()).outcome).toBe("uncertain");
      expect(f.registry.size).toBe(1);
    } finally {signal.mockRestore();}
  });
  test("default unpinned cleanup keeps escalation and ordinary verified release", async () => {
    const f=fixture();await f.registry.register(identity);
    const signal=vi.spyOn(process,"kill").mockImplementation((_pid,kind)=> {
      if(kind==="SIGKILL") f.setRows([]);return true;
    });
    try {
      expect(await f.registry.release(identity,0)).toBe(true);
      expect(signal.mock.calls.some(([,kind])=>kind==="SIGKILL")).toBe(true);expect(f.registry.size).toBe(0);
    } finally {signal.mockRestore();}
  });
  test("unrequested observation is uncertain", async () => {
    expect((await fixture().registry.observeNonforcingExit()).outcome).toBe("uncertain");
  });
  test("observation rejection is bounded uncertain and retains the ledger", async () => {
    const registry=new SupervisedProcessTreeRegistry(async()=>{throw Error("probe fault");});
    registry.remember(identity,true);registry.pinNonforcingShutdown();
    expect((await registry.observeNonforcingExit()).outcome).toBe("uncertain");expect(registry.size).toBe(1);
  });
  test("an unresolved observation deadline cannot rewrite its sealed result", async () => {
    let finish!: (rows:typeof root[])=>void;
    const registry=new SupervisedProcessTreeRegistry(()=>new Promise(resolve=>{finish=resolve;}));
    registry.remember(identity,true);registry.markExited(identity);registry.pinNonforcingShutdown();
    const retained=await registry.observeNonforcingExit(1);expect(retained.outcome).toBe("uncertain");
    finish([]);await new Promise(resolve=>setTimeout(resolve,1));expect(retained.outcome).toBe("uncertain");
  });
  test("new observed owned descendants are retained across later reparenting", async () => {
    const f=fixture();f.setRows([root]);await f.registry.register(identity);f.registry.pinNonforcingShutdown();
    f.setRows([root,child]);expect((await f.registry.observeNonforcingExit()).survivors).toBe(2);
    f.registry.markExited(identity);f.setRows([{...child,parentPid:1}]);
    expect((await f.registry.observeNonforcingExit()).survivors).toBe(1);
    expect(f.registry.snapshots()[0].processes).toHaveLength(2);
  });
  test("new tree registration racing an all-tree observation cannot be omitted", async () => {
    let finish!: (rows:typeof root[])=>void;
    const registry=new SupervisedProcessTreeRegistry(()=>new Promise(resolve=>{finish=resolve;}));
    registry.remember(identity,true);registry.markExited(identity);registry.pinNonforcingShutdown();
    const observation=registry.observeNonforcingExit();await new Promise(resolve=>setTimeout(resolve,1));
    registry.remember({pid:999_930,processGroupId:999_930},true);finish([]);
    expect((await observation).outcome).toBe("uncertain");expect(registry.size).toBe(2);
  });
  test.each(["observe","refresh"])("%s ledger overflow stays UNKNOWN after root exit and reparenting", async operation => {
    const f=fixture();f.setRows([root]);await f.registry.register(identity);f.registry.pinNonforcingShutdown();
    const descendants=Array.from({length:4096},(_,index)=>({...child,pid:800_000+index,
      processGroupId:800_000+index,startedAt:`child ${index}`}));
    f.setRows([root,...descendants]);
    if(operation==="refresh") await expect(f.registry.refresh()).rejects.toThrow(/ledger-limit/);
    else expect((await f.registry.observeNonforcingExit()).outcome).toBe("uncertain");
    f.registry.markExited(identity);f.setRows([{...descendants.at(-1)!,parentPid:1}]);
    expect((await f.registry.observeNonforcingExit()).outcome).toBe("uncertain");
    f.setRows([]);expect((await f.registry.observeNonforcingExit()).outcome).toBe("uncertain");
    expect(f.registry.size).toBe(1);
  });
  test("oversize supplied ledger merge cannot silently certify missing descendants", async () => {
    const f=fixture();await f.registry.register(identity);f.registry.pinNonforcingShutdown();
    f.registry.merge({root:identity,processes:Array.from({length:4097},(_,index)=>({...child,pid:800_000+index}))});
    f.registry.markExited(identity);f.setRows([]);
    expect((await f.registry.observeNonforcingExit()).outcome).toBe("uncertain");
  });
  test("an incomplete snapshot retains UNKNOWN across serialization and a new registry", async () => {
    const f=fixture();await f.registry.register(identity);f.registry.pinNonforcingShutdown();
    f.registry.merge({root:identity,processes:[],incomplete:true});f.registry.markExited(identity);
    const snapshots=JSON.parse(JSON.stringify(f.registry.snapshots()));
    expect(snapshots[0].incomplete).toBe(true);
    const recovered=new SupervisedProcessTreeRegistry(async()=>[]);
    recovered.remember(identity);recovered.merge(snapshots[0]);recovered.pinNonforcingShutdown();
    expect((await recovered.observeNonforcingExit()).outcome).toBe("uncertain");
    recovered.forget(identity);expect(recovered.size).toBe(1);
  });
  test("a pre-pin overflow remains unknown even after ordinary cleanup sees an empty table", async () => {
    const f=fixture();f.setRows([root]);await f.registry.register(identity);
    f.setRows([root,...Array.from({length:4096},(_,index)=>({...child,pid:800_000+index}))]);
    await expect(f.registry.refresh()).rejects.toThrow(/ledger-limit/);
    f.registry.markExited(identity);f.setRows([]);
    expect(await f.registry.cleanupAll(0)).toBe(false);f.registry.forget(identity);expect(f.registry.size).toBe(1);
    f.registry.pinNonforcingShutdown();expect((await f.registry.observeNonforcingExit()).outcome).toBe("uncertain");
  });
  test.each(["release","cleanup"])("%s continuation retains each birth-bound child before a later observer fault", async operation => {
    let rows=[root],reads=0,afterPinReads=0,pinned=false;
    const registry=new SupervisedProcessTreeRegistry(async()=> {
      reads++;
      if(pinned && ++afterPinReads>1) throw Error("later probe fault");
      return rows;
    });
    await registry.register(identity);
    const signal=vi.spyOn(process,"kill").mockImplementation(()=> {
      registry.pinNonforcingShutdown();pinned=true;rows=[root,child];return true;
    });
    try {
      if(operation==="release") await expect(registry.release(identity,0)).rejects.toThrow("later probe fault");
      else expect(await registry.cleanupAll(0)).toBe(false);
      expect(reads).toBeGreaterThan(2);
      const snapshot=registry.snapshots()[0];
      expect(snapshot.processes).toContainEqual(expect.objectContaining({pid:child.pid,startedAt:child.startedAt}));
      const recovered=new SupervisedProcessTreeRegistry(async()=>[{...child,parentPid:1}]);
      recovered.remember(identity);recovered.merge(JSON.parse(JSON.stringify({...snapshot,rootExited:true})));
      recovered.pinNonforcingShutdown();
      expect((await recovered.observeNonforcingExit()).exited).toBe(false);
      expect(signal.mock.calls.some(([,kind])=>kind==="SIGKILL")).toBe(false);
    } finally {signal.mockRestore();}
  });
});
