import Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {expect,test} from "vitest";
import {ChildProcessTelemetryService} from "../src/telemetryService.js";
const policy={allowSigkillEscalation:false as const,graceMs:250};
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function absent(pid:number){const until=Date.now()+6000;while(alive(pid)){if(Date.now()>until)throw Error("TELEMETRY_FIXTURE_EXIT_UNCONFIRMED");await new Promise(done=>setTimeout(done,20));}}
test("actual telemetry child closes its SQLite resource and original process without changing source identity",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"telemetry-nf-")),file=path.join(root,"telemetry.sqlite"),source=randomUUID();
 const service=await ChildProcessTelemetryService.start(file,{sourceStateDatabaseId:source}),pid=service.processId!;
 const result=await service.closeNonforcing(policy);expect(result.exited).toBe(true);await absent(pid);expect(service.status().connected).toBe(false);
 const database=new Database(file,{readonly:true});expect(database.prepare("SELECT value FROM telemetry_meta WHERE key='source_state_database_id'").get()).toEqual({value:source});database.close();
 console.log("ACTUAL_TELEMETRY_NONFORCING_EXIT",JSON.stringify({pid,result}));await service.close();await rm(root,{recursive:true});
},25000);
test("actual telemetry drains already delivered record but preserves all unconfirmed parent evidence",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"telemetry-nf-")),file=path.join(root,"telemetry.sqlite");
 const service=await ChildProcessTelemetryService.start(file),pid=service.processId!;
 service.recordDiagnosticEvent({severity:"info",component:"state",code:"nonforcing.delivered"});
 service.recordDiagnosticEvent({severity:"info",component:"state",code:"nonforcing.undelivered"});
 const originalStatus=service.status(),deliveryId=(service as any).inFlight.value.deliveryId;
 const result=await service.closeNonforcing(policy);expect(result.exited).toBe(true);await absent(pid);
 expect(service.status()).toMatchObject({queued:originalStatus.queued,inFlight:originalStatus.inFlight});
 expect((service as any).inFlight.value.deliveryId).toBe(deliveryId);
 const database=new Database(file,{readonly:true});expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_record_deliveries WHERE delivery_id=?").get(deliveryId)).toEqual({count:1});
 expect(database.prepare("SELECT COUNT(*) AS count FROM diagnostic_events WHERE code='nonforcing.undelivered'").get()).toEqual({count:0});database.close();
 expect((await service.observeNonforcingExit()).exited).toBe(true);
 console.log("ACTUAL_TELEMETRY_RETAINED_DELIVERY",JSON.stringify({pid,result,queued:service.status().queued,inFlight:service.status().inFlight}));
 await service.close();await rm(root,{recursive:true});
},25000);
