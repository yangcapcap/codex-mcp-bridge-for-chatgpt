import { describe, expect, test, vi } from "vitest";
import { boundedShutdown, combineShutdown, observeShutdown, shutdownGrace, shutdownResult,
  validShutdownResult } from "../src/shutdown.js";

describe("fail-closed bounded shutdown receipts", () => {
  test.each([{},null,{allowSigkillEscalation:"false"},{allowSigkillEscalation:false,graceMs:-1},
    {allowSigkillEscalation:false,graceMs:Infinity},{allowSigkillEscalation:false,graceMs:60_001},
    {allowSigkillEscalation:false,unknown:true},Object.create({allowSigkillEscalation:false})])
    ("rejects malformed policy before operation: %j", policy => {
      expect(() => shutdownGrace(policy as never)).toThrow(/POLICY/);
    });
  test("validates exact consistent receipts and rejects forged success", () => {
    const exited=shutdownResult("exited"); expect(Object.isFrozen(exited)).toBe(true);
    expect(validShutdownResult(exited)).toBe(true);
    for (const value of [undefined,{...exited,survivors:1},{...exited,extra:true},
      {...exited,exited:false},{...exited,signalFailures:-1},{...exited,identityChanges:Infinity}]) {
      expect(validShutdownResult(value)).toBe(false);
    }
    expect(() => shutdownResult("exited",1)).toThrow(/RESULT/);
  });
  test("does not mistake void, rejection or timeout for observed exit", async () => {
    expect((await boundedShutdown(async()=>{})).outcome).toBe("uncertain");
    expect((await boundedShutdown(async()=>{throw Error("unknown");})).outcome).toBe("uncertain");
    expect((await boundedShutdown(()=>new Promise(()=>{}),1)).outcome).toBe("uncertain");
    expect(await boundedShutdown(async()=>shutdownResult("timeout",2))).toEqual(shutdownResult("timeout",2));
  });
  test("validates deadline before starting an operation", async () => {
    const operation=vi.fn(async()=>shutdownResult("exited"));
    await expect(boundedShutdown(operation,NaN)).rejects.toThrow(/DEADLINE/);
    expect(operation).not.toHaveBeenCalled();
  });
  test("combines actual failures and does not accept missing or overflowing evidence", () => {
    expect(combineShutdown([]).outcome).toBe("uncertain");
    expect(combineShutdown([undefined as never]).outcome).toBe("uncertain");
    expect(combineShutdown([shutdownResult("timeout",2),shutdownResult("uncertain",1,1,1)]))
      .toEqual(shutdownResult("uncertain",3,1,1));
    expect(combineShutdown([shutdownResult("timeout",Number.MAX_SAFE_INTEGER),shutdownResult("timeout",1)]).outcome)
      .toBe("uncertain");
    expect(combineShutdown([shutdownResult("exited"),shutdownResult("exited")]).exited).toBe(true);
  });
  test("observation requires fresh valid evidence", async () => {
    expect((await observeShutdown({})).outcome).toBe("uncertain");
    expect((await observeShutdown({observeNonforcingExit:()=>undefined as never})).outcome).toBe("uncertain");
    expect((await observeShutdown({observeNonforcingExit:()=>{throw Error("unknown");}})).outcome).toBe("uncertain");
    expect((await observeShutdown({observeNonforcingExit:()=>shutdownResult("exited")})).exited).toBe(true);
  });
  test("rejects getters without invoking them, and retains immutable receipt snapshots", async () => {
    const getter=vi.fn(()=>true);
    const malformed={...shutdownResult("exited")};
    Object.defineProperty(malformed,"exited",{get:getter,enumerable:true});
    expect(validShutdownResult(malformed)).toBe(false);
    expect((await boundedShutdown(async()=>malformed)).outcome).toBe("uncertain");
    expect(getter).not.toHaveBeenCalled();
    const original={...shutdownResult("timeout",1)};
    const result=await boundedShutdown(async()=>original);
    original.outcome="exited";original.exited=true;original.survivors=0;
    expect(result).toEqual(shutdownResult("timeout",1));expect(Object.isFrozen(result)).toBe(true);
  });
  test("rejects every missing array member including sparse and inherited slots", () => {
    const hole=new Array(1);
    const tail=[shutdownResult("exited")];tail.length=2;
    const inherited=new Array(1);Object.setPrototypeOf(inherited,{0:shutdownResult("exited")});
    for (const list of [hole,tail,inherited]) expect(combineShutdown(list).outcome).toBe("uncertain");
  });
  test("rejects policy accessors without evaluating them", () => {
    const getter=vi.fn(()=>false), policy={};
    Object.defineProperty(policy,"allowSigkillEscalation",{get:getter,enumerable:true});
    expect(()=>shutdownGrace(policy as never)).toThrow(/POLICY/);
    expect(getter).not.toHaveBeenCalled();
  });
  test("observer property faults and hanging observations stay bounded and uncertain", async () => {
    const target=Object.defineProperty({},"observeNonforcingExit",{get(){throw Error("observer-access");}});
    await expect(observeShutdown(target)).resolves.toMatchObject({outcome:"uncertain"});
    const result=await Promise.race([
      observeShutdown({observeNonforcingExit:()=>new Promise(()=>{})},1),
      new Promise(resolve=>setTimeout(()=>resolve("still-pending"),50))
    ]);
    expect(result).toMatchObject({outcome:"uncertain"});
  });
  test("exact data fields reject symbols, collection accessors and invalid grace values", async () => {
    const key=Symbol("extra"), receipt={...shutdownResult("exited"),[key]:true};
    expect(validShutdownResult(receipt)).toBe(false);
    expect((await boundedShutdown(async()=>receipt)).outcome).toBe("uncertain");
    const getter=vi.fn(()=>shutdownResult("exited")), list=new Array(1);
    Object.defineProperty(list,"0",{get:getter});
    expect(combineShutdown(list).outcome).toBe("uncertain");expect(getter).not.toHaveBeenCalled();
    const extras=[shutdownResult("exited")];Object.defineProperty(extras,key,{value:true});
    expect(combineShutdown(extras).outcome).toBe("uncertain");
    expect(()=>shutdownGrace({allowSigkillEscalation:false,[key]:true} as never)).toThrow(/POLICY/);
    expect(()=>shutdownGrace({allowSigkillEscalation:false,graceMs:null} as never)).toThrow(/POLICY/);
  });
});
