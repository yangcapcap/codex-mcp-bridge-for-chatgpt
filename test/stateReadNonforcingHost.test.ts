import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect,test} from "vitest";
import {BridgeStateStore} from "../src/stateStore.js";
import {ChildProcessStateReadService} from "../src/stateReadProcess.js";
import {loadConfig} from "../src/config.js";
import {UserSettingsStore} from "../src/userSettings.js";
import {ScopeResolver} from "../src/scopeResolver.js";
const policy={allowSigkillEscalation:false as const,graceMs:250};
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),"state-read-nf-")),home=path.join(root,"codex");await mkdir(home);
 const file=path.join(root,"state.sqlite");
 const environment={...process.env,HOME:root,CODEX_HOME:home,CODEX_MCP_BRIDGE_NO_AUTH:"1",CODEX_MCP_BRIDGE_CODEX:"/usr/bin/false",
  CODEX_MCP_BRIDGE_RUNTIME_HOME:path.join(root,"runtime"),CODEX_MCP_BRIDGE_STATE_DATABASE_FILE:file,
  CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE:path.join(root,"telemetry.sqlite"),
  CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE:path.join(root,"models.json"),CODEX_MCP_BRIDGE_SKILLS_DIRECTORY:path.join(root,"skills")};
 const store=new BridgeStateStore({file}),databaseId=store.databaseId;
 new UserSettingsStore(loadConfig(environment),{stateStore:store});new ScopeResolver({stateStore:store});store.close();
 const service=await ChildProcessStateReadService.start(file,environment);return {root,file,service,databaseId};
}
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function absent(pid:number){const until=Date.now()+6000;while(alive(pid)){if(Date.now()>until)throw Error("STATE_READ_FIXTURE_EXIT_UNCONFIRMED");await new Promise(done=>setTimeout(done,20));}}
test("actual private read child closes with owner/resource receipt and no database owner mutation",async()=>{
 const {root,file,service,databaseId}=await fixture(),pid=service.processId!;
 await expect(service.settingsSnapshot()).resolves.toMatchObject({settings:{settingsRevision:0}});
 const result=await service.closeNonforcing(policy);console.log("ACTUAL_READ_NONFORCING_EXIT",JSON.stringify({pid,result}));
 expect(result.exited).toBe(true);await absent(pid);expect(service.health().ready).toBe(false);
 const verify=new BridgeStateStore({file,readOnly:true});expect(verify.databaseId).toBe(databaseId);verify.close();
 await service.close();await rm(root,{recursive:true});
},25000);
test("actual read queued before pin may drain but its parent reservation stays unknown after exit",async()=>{
 const {root,service}=await fixture(),pid=service.processId!;
 const pending=service.settingsSnapshot().catch(error=>error);const result=await service.closeNonforcing(policy);
 expect((await pending).message).toContain("OUTCOME_UNKNOWN");expect(result.exited).toBe(true);await absent(pid);
 expect((service as any).pending.size).toBe(1);expect((await service.observeNonforcingExit()).exited).toBe(true);
 console.log("ACTUAL_READ_RETAINED_RESERVATION",JSON.stringify({pid,result,reservations:(service as any).pending.size}));
 await service.close();await rm(root,{recursive:true});
},25000);
