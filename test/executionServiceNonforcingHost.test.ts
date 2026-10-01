import {mkdtemp,readFile,rm} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import path from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {expect,test} from "vitest";
import {ChildProcessCodexExecutionService} from "../src/executionServiceProcess.js";
const fixture=fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs",import.meta.url));
const policy={allowSigkillEscalation:false as const,graceMs:250};
async function create(extra:NodeJS.ProcessEnv={}){
 const home=await mkdtemp(path.join(tmpdir(),"exec-nf-"));
 const service=await ChildProcessCodexExecutionService.start({command:fixture,poolSize:1,
  environment:{...process.env,HOME:home,CODEX_HOME:path.join(home,".codex"),...extra}});
 return {home,service};
}
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function eventually(check:()=>boolean){const end=Date.now()+6000;while(!check()){if(Date.now()>end)throw Error("FIXTURE_CONDITION_TIMEOUT");await new Promise(done=>setTimeout(done,20));}}
async function finish(service:ChildProcessCodexExecutionService){
 let result=await service.observeNonforcingExit();
 for(let i=0;i<5 && result.outcome==="timeout";i++){await new Promise(done=>setTimeout(done,40));result=await service.observeNonforcingExit();}
 expect(result.exited).toBe(true);return result;
}
test("actual executor exits only after correlated zero-worker proof and retains the final tree ledger",async()=>{
 const {home,service}=await create();const pid=service.processId!;
 await service.readAccountRateLimits();const endpoint=(service as any).endpoint;
 const result=await service.closeNonforcing(policy);console.log("ACTUAL_NONFORCING_CLOSE",JSON.stringify({pid,result}));
 expect(result.exited).toBe(true);await eventually(()=>!alive(pid));
 const trees=JSON.parse(await readFile(path.join(endpoint.directory,"trees.json"),"utf8"));
 expect(trees.length).toBeGreaterThan(0);expect(trees.every((tree:any)=>tree.rootExited)).toBe(true);
 await service.close();await rm(home,{recursive:true});
},25000);
test("a detached observed descendant keeps owner live until its actual exit, then a fresh observation may finalize",async()=>{
 const observation=path.join(tmpdir(),"nonforcing-descendant-"+process.pid+".jsonl");
 const {home,service}=await create({CODEX_TEST_DESCENDANT_OBSERVATION:observation});
 const pid=service.processId!;let assignment=false;
 const running=service.callTool("codex",{prompt:"execution descendant hold detached",cwd:process.cwd(),sandbox:"read-only","approval-policy":"on-request"},undefined,()=>{assignment=true;}).catch(error=>error);
 await eventually(()=>assignment);
 let childPid=0;await eventually(()=>{try{const values=JSON.parse(execFileSync("/bin/cat",[observation],{encoding:"utf8"}).trim());childPid=values.childPid;return childPid>0;}catch{return false;}});
 const birth=execFileSync("/bin/ps",["-p",String(childPid),"-o","pid=,pgid=,lstart=,comm="],{encoding:"utf8"}).trim();
 await new Promise(done=>setTimeout(done,700));
 const old=await service.closeNonforcing(policy);
 console.log("ACTUAL_DESCENDANT_TIMEOUT",JSON.stringify({pid,childPid,birth,old}));
 expect(old.outcome).toBe("timeout");expect(old.survivors).toBeGreaterThanOrEqual(2);expect(alive(pid)).toBe(true);expect(alive(childPid)).toBe(true);
 // Dispose only the fixture child, outside the shutdown API, after exact birth
 // and separate group readback. The candidate has sent no signal to this escapee.
 const current=execFileSync("/bin/ps",["-p",String(childPid),"-o","pid=,pgid=,lstart=,comm="],{encoding:"utf8"}).trim();
 expect(current).toBe(birth);expect(Number(current.split(/\s+/)[1])).toBe(childPid);
 process.kill(childPid,"SIGTERM");await eventually(()=>!alive(childPid));
 const fresh=await finish(service);await eventually(()=>!alive(pid));expect(old.outcome).toBe("timeout");
 console.log("ACTUAL_DESCENDANT_FRESH_EXIT",JSON.stringify({pid,childPid,fresh}));
 expect((await running).message).toContain("OUTCOME_UNKNOWN");
 await expect(service.close()).rejects.toThrow("UNCONFIRMED");await rm(home,{recursive:true});await rm(observation);
},30000);
