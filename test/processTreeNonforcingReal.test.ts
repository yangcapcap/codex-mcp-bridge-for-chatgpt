import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import { readProcessTable, SupervisedProcessTreeRegistry } from "../src/processTreeSupervisor.js";

describe.skipIf(process.platform === "win32")("owned real nonforcing tree fixtures", () => {
  test("retains an escaped actual child after its parent exits and keeps the old timeout", async () => {
    const childCode="process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)";
    const code=`const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],
        {detached:true,stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',()=>process.stdout.write(child.pid+'\\n'));
      setInterval(()=>{},1000);`;
    const parent=spawn(process.execPath,["-e",code],{detached:true,stdio:["ignore","pipe","ignore"]});
    const identity={pid:parent.pid!,processGroupId:parent.pid!};
    const registry=new SupervisedProcessTreeRegistry();
    let childPid:number|undefined, childBirth:string|undefined;
    let timer:NodeJS.Timeout|undefined;
    try {
      const ready=await Promise.race([once(parent.stdout!,"data"),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("fixture readiness deadline")),2000);})]);
      clearTimeout(timer);
      childPid=Number(String(ready[0]).trim());expect(Number.isSafeInteger(childPid)).toBe(true);
      childBirth=(await readProcessTable()).find(p=>p.pid===childPid && p.parentPid===identity.pid)?.startedAt;
      await registry.register(identity);
      expect(registry.snapshots()[0].processes.find(p=>p.pid===childPid)?.startedAt).toBe(childBirth);
      expect(childBirth).toBeTruthy();registry.pinNonforcingShutdown();
      const exited=once(parent,"exit");parent.kill("SIGTERM");await exited;registry.markExited(identity);
      const retained=await registry.observeNonforcingExit();
      expect(retained).toMatchObject({exited:false,outcome:"timeout",survivors:1});
      expect(await registry.release(identity,0)).toBe(false);
      expect(await registry.cleanupAll(0)).toBe(false);
      expect((await readProcessTable()).some(p=>p.pid===childPid && p.startedAt===childBirth)).toBe(true);
      // Fixture owner cleanup follows measurement; the shutdown APIs did not signal it.
      process.kill(childPid!,"SIGKILL");
      for(let attempt=0;attempt<30;attempt++) {
        if((await registry.observeNonforcingExit()).exited) break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect((await registry.observeNonforcingExit()).exited).toBe(true);
      expect(retained.outcome).toBe("timeout");expect(registry.size).toBe(1);
    } finally {
      clearTimeout(timer);
      // Capture an unreported child while its owned parent is still alive,
      // so even a readiness failure does not orphan a synthetic fixture.
      if(!childPid && parent.exitCode===null && parent.signalCode===null) {
        const owned=(await readProcessTable()).find(p=>p.parentPid===identity.pid && p.pid!==identity.pid);
        if(owned) {childPid=owned.pid;childBirth=owned.startedAt;}
      }
      if(parent.exitCode===null && parent.signalCode===null) parent.kill("SIGKILL");
      if(childPid && childBirth) {
        const current=(await readProcessTable()).find(p=>p.pid===childPid);
        if(current?.startedAt===childBirth && !current.state.startsWith("Z")) process.kill(childPid,"SIGKILL");
      }
    }
  },10000);
});
