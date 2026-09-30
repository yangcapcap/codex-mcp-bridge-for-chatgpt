import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { CodexAppServerUpstreamPool, APP_SERVER_CAPABILITIES } from "../src/appServerUpstream.js";
import { readProcessTable, SupervisedProcessTreeRegistry } from "../src/processTreeSupervisor.js";
import type { WorkerShutdownSupervisor } from "../src/workerShutdownReceipt.js";
import type { JsonRpcProcessIdentity } from "../src/jsonRpcProcess.js";

const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),"fixtures/fake-codex-nonforcing-tree.mjs");
describe.skipIf(process.platform==="win32")("actual owned App Server nonforcing tree boundary",()=>{
 test("retains an escaped live child after parent exit; later observation leaves the old receipt intact",async()=>{
  const home=await mkdtemp(path.join(tmpdir(),"cogate-pool-tree-")),childFile=path.join(home,"child.json");
  const registry=new SupervisedProcessTreeRegistry(),ordinaryCleanup=vi.fn();
  const audit=async(stage:string,details:unknown)=>{if(process.env.COGATE_TEST_SHUTDOWN_AUDIT)
    await appendFile(process.env.COGATE_TEST_SHUTDOWN_AUDIT,JSON.stringify({stage,details})+"\n");};
  let root:JsonRpcProcessIdentity|undefined,rootBirth:string|undefined,childPid:number|undefined,childBirth:string|undefined;
  const supervisor:WorkerShutdownSupervisor={pinNonforcingShutdown(){registry.pinNonforcingShutdown();return true;},
   async closeNonforcing(binding){return {binding,result:await registry.observeNonforcingExit()};},
   async observeNonforcingExit(binding){return {binding,result:await registry.observeNonforcingExit()};}};
  const pool=new CodexAppServerUpstreamPool(fixture,1,{environment:{...process.env,HOME:home,CODEX_HOME:path.join(home,"codex"),COGATE_TEST_TREE_CHILD:childFile},
   workerShutdownSupervisor:supervisor,
   async onWorkerProcessStarted(identity){root=identity;
    rootBirth=(await readProcessTable()).find(p=>p.pid===identity.pid)?.startedAt;expect(rootBirth).toBeTruthy();
    await vi.waitFor(async()=>{childPid=JSON.parse(await readFile(childFile,"utf8")).pid;expect(childPid).toBeGreaterThan(0);},{timeout:2500});
    childBirth=(await readProcessTable()).find(p=>p.pid===childPid && p.parentPid===identity.pid)?.startedAt;
    expect(childBirth).toBeTruthy();await registry.register(identity);
    expect(registry.snapshots()[0].processes.find(p=>p.pid===childPid)?.startedAt).toBe(childBirth);
   },onWorkerProcessExitObserved(identity){registry.markExited(identity);},onWorkerProcessExited:ordinaryCleanup},
   {versionProbe:async()=>"99.0.0",protocolProbe:async()=>({compatible:true,missingCore:[],unsupported:{},capabilities:APP_SERVER_CAPABILITIES})});
  try {
   await pool.listModels();
   const retained=await pool.closeNonforcing({allowSigkillEscalation:false,graceMs:150});
   expect(retained.exited).toBe(false);expect(ordinaryCleanup).not.toHaveBeenCalled();
   expect((await readProcessTable()).some(p=>p.pid===childPid && p.startedAt===childBirth && !p.state.startsWith("Z"))).toBe(true);
   expect(registry.snapshots()[0].processes.find(p=>p.pid===childPid)?.startedAt).toBe(childBirth);
   await expect(pool.close()).rejects.toThrow("NONFORCING_SHUTDOWN_UNCONFIRMED");
   const fresh=await pool.observeNonforcingExit();expect(fresh).toMatchObject({outcome:"timeout",survivors:1});
   await audit("actual-survivor-measurement",{root,rootBirth,childPid,childBirth,retained,fresh,
    retainedTrees:registry.snapshots(),ownedLive:(await readProcessTable()).filter(p=>
      p.pid===root?.pid && p.startedAt===rootBirth || p.pid===childPid && p.startedAt===childBirth)});
   // Explicit fixture-owner cleanup after the API measurements, birth-checked.
   const current=(await readProcessTable()).find(p=>p.pid===childPid);
   expect(current?.startedAt).toBe(childBirth);process.kill(childPid!,"SIGKILL");
   await vi.waitFor(async()=>expect((await pool.observeNonforcingExit()).exited).toBe(true),{timeout:3000});
   expect(retained.exited).toBe(false);expect(registry.size).toBe(1);expect(ordinaryCleanup).not.toHaveBeenCalled();
   await audit("fresh-exit-after-owned-cleanup",{root,rootBirth,childPid,childBirth,retained,
    fresh:await pool.observeNonforcingExit(),retainedTrees:registry.snapshots()});
  } finally {
   if(root){const table=await readProcessTable();
    if(!childPid){const child=table.find(p=>p.parentPid===root!.pid);childPid=child?.pid;childBirth=child?.startedAt;}
    const parent=table.find(p=>p.pid===root!.pid);if(parent && rootBirth && parent.startedAt===rootBirth && parent.processGroupId===root.processGroupId && !parent.state.startsWith("Z"))process.kill(parent.pid,"SIGKILL");
    const child=table.find(p=>p.pid===childPid);if(child && childBirth && child.startedAt===childBirth && !child.state.startsWith("Z"))process.kill(child.pid,"SIGKILL");
   }
   const remaining=(await readProcessTable()).filter(p=>!p.state.startsWith("Z") &&
    (p.pid===root?.pid && p.startedAt===rootBirth || p.pid===childPid && p.startedAt===childBirth));
   await audit("final-owned-cleanup",{root,rootBirth,childPid,childBirth,remaining});
   expect(remaining).toEqual([]);
   await rm(home,{recursive:true,force:true});
  }
 },12000);
});
