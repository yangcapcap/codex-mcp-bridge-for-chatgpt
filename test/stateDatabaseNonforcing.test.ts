import {test,expect,vi} from "vitest";
import Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {StateDatabaseShutdownFence} from "../src/stateDatabaseShutdownFence.js";
import {BridgeStateStore} from "../src/stateStore.js";

function fixture() {
  const native = new Database(":memory:");
  native.exec("CREATE TABLE retained(value INTEGER);INSERT INTO retained VALUES(1),(2)");
  const fence = new StateDatabaseShutdownFence(native);
  return {native,fence,db:fence.database};
}
test("owned database preserves ordinary statement and transaction semantics",()=>{
  const {native,db}=fixture();try {
    expect(db.prepare("SELECT value FROM retained").all()).toEqual([{value:1},{value:2}]);
    const write=db.prepare("INSERT INTO retained VALUES(?)");
    const transaction=db.transaction((value:number)=>write.run(value));
    expect(transaction.immediate(3).changes).toBe(1);
    expect(write.database).toBe(db);expect(transaction.database).toBe(db);
    expect([...db.prepare("SELECT value FROM retained ORDER BY value").iterate()]).toEqual([{value:1},{value:2},{value:3}]);
  } finally {native.close();}
});
test("cached statements, captured methods and transaction variants reject after pin",()=>{
  const {native,fence,db}=fixture();const statement=db.prepare("INSERT INTO retained VALUES(?)");
  const run=statement.run;const transaction=db.transaction(()=>statement.run(4));const immediate=transaction.immediate;
  try {fence.pinNonforcingShutdown();for(const write of [()=>run(3),()=>transaction(),()=>immediate(),()=>db.exec("DELETE FROM retained"),()=>db.pragma("user_version=4")])
    expect(write).toThrow("STATE_DATABASE_NONFORCING_PINNED");
    expect(native.prepare("SELECT COUNT(*) AS n FROM retained").get()).toEqual({n:2});
    expect(fence.closeNonforcing().exited).toBe(true);expect(fence.observeNonforcingExit().exited).toBe(true);
  } finally {if(native.open)native.close();}
});
test("a native transaction reentry pin rolls back and remains UNKNOWN",()=>{
  const {native,fence,db}=fixture();try {
    const transaction=db.transaction(()=>{db.prepare("INSERT INTO retained VALUES(3)").run();fence.pinNonforcingShutdown();return 1;});
    expect(transaction).toThrow("STATE_DATABASE_NONFORCING_PINNED");
    expect(native.prepare("SELECT COUNT(*) AS n FROM retained").get()).toEqual({n:2});
    expect(fence.closeNonforcing().outcome).toBe("uncertain");expect(native.open).toBe(true);
  } finally {native.close();}
});
test("live iterator prevents resource close; its cleanup permits fresh observation",()=>{
  const {native,fence,db}=fixture();const iterator=db.prepare("SELECT value FROM retained").iterate();
  try {expect(iterator.next().done).toBe(false);fence.pinNonforcingShutdown();
    expect(()=>iterator.next()).toThrow("STATE_DATABASE_NONFORCING_PINNED");expect(fence.closeNonforcing().outcome).toBe("timeout");
    iterator.return!();expect(fence.closeNonforcing().exited).toBe(true);
  } finally {if(native.open)native.close();}
});
test("an ordinary close can never be upgraded into a nonforcing receipt",()=>{
  const {native,fence,db}=fixture();db.close();fence.pinNonforcingShutdown();expect(fence.closeNonforcing().outcome).toBe("uncertain");expect(native.open).toBe(false);
});
test("failed native close is sticky and is never retried",()=>{
  const native=new Database(":memory:");const original=native.close.bind(native);const close=vi.fn(()=>{throw new Error("unconfirmed");});native.close=close;
  const fence=new StateDatabaseShutdownFence(native);try{fence.pinNonforcingShutdown();expect(fence.closeNonforcing().outcome).toBe("uncertain");expect(fence.closeNonforcing().outcome).toBe("uncertain");expect(close).toHaveBeenCalledTimes(1);}finally{original();}
});
test("registry database resource close preserves durable instance retirement evidence",()=>{
  const store=new BridgeStateStore({file:":memory:"});const native=(store as any).databaseShutdown.owned as Database.Database;
  const row=native.prepare("SELECT * FROM bridge_instances WHERE instance_id=?").get(store.bridgeInstanceId);
  try {store.pinNonforcingShutdown();expect(()=>store.createAgent({scopeId:randomUUID(),agentName:"late"})).toThrow("STATE_DATABASE_NONFORCING_PINNED");
    expect(native.prepare("SELECT * FROM bridge_instances WHERE instance_id=?").get(store.bridgeInstanceId)).toEqual(row);
    expect(store.closeNonforcing().exited).toBe(true);expect(store.observeNonforcingExit().exited).toBe(true);
  } finally {if(native.open)native.close();}
});

test("ordinary native transaction variants preserve the caller receiver",()=>{
 const {native,db}=fixture();try {
  const callback=function(this:{value:number}) {return this.value;};const transaction=db.transaction(callback);const context={value:17};
  expect(Reflect.apply(transaction,context,[])).toBe(17);expect(transaction.call(context)).toBe(17);expect(transaction.immediate.call(context)).toBe(17);
 } finally {native.close();}
});
