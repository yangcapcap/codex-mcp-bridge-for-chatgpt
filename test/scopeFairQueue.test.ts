import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopeFairQueue } from "../src/scopeFairQueue.js";

afterEach(() => vi.useRealTimers());

describe("ScopeFairQueue", () => {
  it("runs one item per scope in round-robin order", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const queue = new ScopeFairQueue<string>({
      capacity: 8,
      perScopeCapacity: 4,
      run: value => observed.push(value)
    });
    queue.enqueue("a", "a1");
    queue.enqueue("a", "a2");
    queue.enqueue("a", "a3");
    queue.enqueue("b", "b1");
    queue.enqueue("b", "b2");

    await vi.runAllTimersAsync();

    expect(observed).toEqual(["a1", "b1", "a2", "b2", "a3"]);
    expect(queue.status()).toMatchObject({ queued: 0, scopes: 0, processed: 5, dropped: 0 });
  });

  it("bounds one scope and admits another scope under saturation", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const queue = new ScopeFairQueue<string>({
      capacity: 4,
      perScopeCapacity: 3,
      run: value => observed.push(value)
    });
    for (const value of ["a1", "a2", "a3", "a4", "a5"]) queue.enqueue("a", value);
    expect(queue.enqueue("b", "b1")).toBe(true);
    expect(queue.status()).toMatchObject({ queued: 4, scopes: 2, dropped: 2 });

    await vi.runAllTimersAsync();

    expect(observed).toEqual(["a3", "b1", "a4", "a5"]);
  });

  it("removes stale work and drops remaining work on close", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const queue = new ScopeFairQueue<string>({
      capacity: 6,
      perScopeCapacity: 3,
      run: value => observed.push(value)
    });
    queue.enqueue("a", "remove");
    queue.enqueue("a", "keep");
    queue.enqueue("b", "drop-on-close");
    expect(queue.remove(value => value === "remove")).toBe(1);
    queue.close();

    await vi.runAllTimersAsync();

    expect(observed).toEqual([]);
    expect(queue.status()).toMatchObject({ queued: 0, scopes: 0, processed: 0, dropped: 3 });
  });
});

describe("nonforcing projection retention",()=>{
  it("pins without dropping queued snapshots and prevents ordinary close/removal from erasing them",async()=>{
    vi.useFakeTimers();const run=vi.fn(),predicate=vi.fn(()=>true);
    const queue=new ScopeFairQueue<string>({capacity:4,perScopeCapacity:2,run});
    queue.enqueue("a","a1");queue.enqueue("b","b1");const before=queue.status();
    expect(queue.pinNonforcingShutdown()).toBe(true);expect(queue.nonforcingHistoryUncertain).toBe(false);
    expect(queue.enqueue("a","late")).toBe(false);expect(queue.remove(predicate)).toBe(0);queue.close();await vi.runAllTimersAsync();
    expect(queue.status()).toEqual(before);expect(predicate).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
  });
  it("an already delivered scheduler callback cannot consume retained work after pin",()=>{
    vi.useFakeTimers();let callback:(()=>void)|undefined;
    const scheduled=vi.spyOn(globalThis,"setImmediate").mockImplementation(((fn:()=>void)=>{callback=fn;return {unref(){}};}) as any);
    const run=vi.fn(),queue=new ScopeFairQueue<string>({capacity:4,perScopeCapacity:2,run});queue.enqueue("a","retained");const before=queue.status();
    queue.pinNonforcingShutdown();callback!();expect(run).not.toHaveBeenCalled();expect(queue.status()).toEqual(before);scheduled.mockRestore();
  });
  it("prior ordinary discard remains unknown instead of certifying an originally empty queue",()=>{
    const queue=new ScopeFairQueue<string>({capacity:4,perScopeCapacity:2,run:vi.fn()});queue.enqueue("a","old");queue.close();
    queue.pinNonforcingShutdown();expect(queue.nonforcingHistoryUncertain).toBe(true);expect(queue.status().dropped).toBe(1);
    queue.pinNonforcingShutdown();expect(queue.nonforcingHistoryUncertain).toBe(true);
  });
});

it("a remove predicate that reentrantly pins cannot partially erase retained snapshots",()=>{
  vi.useFakeTimers();const queue=new ScopeFairQueue<string>({capacity:4,perScopeCapacity:2,run:vi.fn()});
  queue.enqueue("a","a1");queue.enqueue("a","a2");queue.enqueue("b","b1");const before=queue.status();let calls=0;
  expect(queue.remove(value=>{calls++;if(value==="a2")queue.pinNonforcingShutdown();return true;})).toBe(0);
  expect(calls).toBe(2);expect(queue.status()).toEqual(before);
});
it("a run accessor that pins cannot consume its selected snapshot or invoke the returned callback",()=>{
  vi.useFakeTimers();const run=vi.fn();let queue:ScopeFairQueue<string>;
  queue=new ScopeFairQueue<string>({capacity:4,perScopeCapacity:2,get run(){queue.pinNonforcingShutdown();return run;}});
  queue.enqueue("a","retained");const before=queue.status();(queue as any).runOne();expect(run).not.toHaveBeenCalled();expect(queue.status()).toEqual(before);
});
