import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { terminateManagedChildren } from "../scripts/child-shutdown.mjs";

describe("managed child shutdown", () => {
  it("waits for a graceful child exit", async () => {
    const child = new FakeChild("SIGINT");
    const result = await terminateManagedChildren(new Set([child]), {
      interruptTimeoutMs: 100,
      terminateTimeoutMs: 100,
      killTimeoutMs: 100
    });
    expect(result.exited).toBe(true);
    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("escalates and still observes exit before completion", async () => {
    const child = new FakeChild("SIGKILL");
    const result = await terminateManagedChildren(new Set([child]), {
      interruptTimeoutMs: 5,
      terminateTimeoutMs: 5,
      killTimeoutMs: 100
    });
    expect(result.exited).toBe(true);
    expect(child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(0);
  });

  it("explicit nonforcing mode preserves an actual survivor and never sends SIGKILL", async () => {
    const child=new FakeChild("SIGKILL");
    const result=await terminateManagedChildren([child],{allowSigkillEscalation:false,
      interruptTimeoutMs:1,terminateTimeoutMs:1,killTimeoutMs:0});
    expect(result).toEqual({exited:false,remaining:[child]});
    expect(child.signals).toEqual(["SIGINT","SIGTERM"]);
    expect(child.listenerCount("exit")).toBe(0);
  });
  it("nonforcing mode observes a graceful TERM exit", async () => {
    const child=new FakeChild("SIGTERM");
    const result=await terminateManagedChildren([child],{allowSigkillEscalation:false,
      interruptTimeoutMs:1,terminateTimeoutMs:100,killTimeoutMs:0});
    expect(result).toEqual({exited:true,remaining:[]});
    expect(child.signals).toEqual(["SIGINT","SIGTERM"]);
  });
  it("pins a nonforcing decision against concurrent and later default cleanup", async () => {
    const child=new FakeChild("SIGKILL");
    const ordinary=terminateManagedChildren([child],{interruptTimeoutMs:5,terminateTimeoutMs:1,killTimeoutMs:0});
    const explicit=terminateManagedChildren([child],{allowSigkillEscalation:false,
      interruptTimeoutMs:1,terminateTimeoutMs:1,killTimeoutMs:0});
    expect((await explicit).exited).toBe(false);expect((await ordinary).exited).toBe(false);
    expect((await terminateManagedChildren([child],{interruptTimeoutMs:0,terminateTimeoutMs:0,killTimeoutMs:0})).exited)
      .toBe(false);
    expect(child.signals).not.toContain("SIGKILL");
  });
  it("rejects invalid policy before sending any signal", async () => {
    const child=new FakeChild("SIGKILL");
    await expect(terminateManagedChildren([child],{allowSigkillEscalation:false,interruptTimeoutMs:NaN}))
      .rejects.toThrow(/POLICY/);
    expect(child.signals).toEqual([]);
  });
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];

  constructor(private readonly exitOn: string) {
    super();
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === this.exitOn) {
      setTimeout(() => {
        this.exitCode = 0;
        this.signalCode = signal;
        this.emit("exit", 0, signal);
      }, 1);
    }
    return true;
  }
}
