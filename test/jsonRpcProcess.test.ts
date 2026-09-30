import { describe, expect, it } from "vitest";
import { JsonRpcProcess, type JsonRpcLateResponse } from "../src/jsonRpcProcess.js";

const FAKE_SERVER = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let heldId;
let parentId;
let omitted = false;
const send = (message) => process.stdout.write(JSON.stringify(omitted ? message : { jsonrpc: "2.0", ...message }) + "\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  omitted = message.jsonrpc === undefined;
  if (message.method === "echo") return send({ id: message.id, result: message.params });
  if (message.method === "invalid-utf8") return process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
  if (message.method === "unpaired-surrogate") {
    return process.stdout.write('{"jsonrpc":"2.0","id":' + message.id + ',"result":"\\ud800"}\n');
  }
  if (message.method === "hold") { heldId = message.id; return; }
  if (message.method === "exit-now") return process.exit(0);
  if (message.method === "release") {
    send({ id: message.id, result: {} });
    if (heldId !== undefined) { send({ id: heldId, result: { released: true } }); heldId = undefined; }
    return;
  }
  if (message.method === "ask-client") {
    parentId = message.id;
    return send({ id: "server-request-7", method: "approval", params: { exact: true } });
  }
  if (message.id === "server-request-7") {
    return send({ id: parentId, result: { clientResponse: message.result } });
  }
  if (message.method === "spawn-child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    return send({ id: message.id, result: { childPid: child.pid } });
  }
});
`;

function processFor(options: {
  omitJsonRpcHeader?: boolean;
  onRequest?: (method: string, params: unknown, requestId: number | string) => unknown;
  onExit?: (error: Error) => void;
  onLateResponse?: (response: JsonRpcLateResponse) => void;
} = {}) {
  return new JsonRpcProcess({
    command: process.execPath,
    args: ["-e", FAKE_SERVER],
    debugLabel: "fake-jsonrpc",
    ...options
  });
}

describe("JsonRpcProcess", () => {
  it("supports regular JSON-RPC and Codex App Server's headerless JSONL dialect", async () => {
    const regular = processFor();
    const headerless = processFor({ omitJsonRpcHeader: true });
    try {
      await expect(regular.request("echo", { mode: "mcp" }, { timeoutMs: 2_000 })).resolves.toEqual({ mode: "mcp" });
      await expect(headerless.request("echo", { mode: "app" }, { timeoutMs: 2_000 })).resolves.toEqual({ mode: "app" });
    } finally {
      await Promise.all([regular.close(), headerless.close()]);
    }
  });

  it("rejects malformed UTF-8 and escaped unpaired surrogates from the App Server", async () => {
    for (const method of ["invalid-utf8", "unpaired-surrogate"]) {
      const rpc = processFor({ omitJsonRpcHeader: true });
      try {
        await expect(rpc.request(method, {}, { timeoutMs: 2_000 })).rejects.toThrow(/UTF-8|surrogate/i);
        expect(rpc.exited).toBe(true);
      } finally {
        await rpc.close();
      }
    }
  });

  it("does not JSON-escape an unpaired surrogate into an outbound App Server request", async () => {
    const rpc = processFor({ omitJsonRpcHeader: true });
    try {
      await expect(rpc.request("echo", { raw: "\ud800" }, { timeoutMs: 2_000 }))
        .rejects.toThrow(/unpaired Unicode surrogate/i);
    } finally {
      await rpc.close();
    }
  });

  it("preserves exact server request IDs on the bidirectional path", async () => {
    const observed: Array<number | string> = [];
    const rpc = processFor({
      omitJsonRpcHeader: true,
      onRequest(method, params, requestId) {
        observed.push(requestId);
        return { method, params, requestId };
      }
    });
    try {
      await expect(rpc.request("ask-client", {}, { timeoutMs: 2_000 })).resolves.toEqual({
        clientResponse: {
          method: "approval",
          params: { exact: true },
          requestId: "server-request-7"
        }
      });
      expect(observed).toEqual(["server-request-7"]);
    } finally {
      await rpc.close();
    }
  });

  it("keeps a turn request pending without a deadline until the backend completes it", async () => {
    const rpc = processFor({ omitJsonRpcHeader: true });
    try {
      const held = rpc.request<{ released: boolean }>("hold");
      const early = await Promise.race([
        held.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100))
      ]);
      expect(early).toBe("pending");
      await rpc.request("release", {}, { timeoutMs: 2_000 });
      await expect(held).resolves.toEqual({ released: true });
    } finally {
      await rpc.close();
    }
  });

  it("identifies an exact late response without disturbing newer request tracking", async () => {
    const lateResponses: JsonRpcLateResponse[] = [];
    const rpc = processFor({
      omitJsonRpcHeader: true,
      onLateResponse: (response) => lateResponses.push(response)
    });
    try {
      const held = rpc.request(
        "hold",
        { marker: "late", secret: "request-params-are-not-retained" },
        { timeoutMs: 25, lateResponseContext: { threadId: "safe-thread-id" } }
      );
      await expect(held).rejects.toMatchObject({
        code: -32001,
        requestId: 1,
        method: "hold",
        timeoutMs: 25,
        processIdentity: expect.objectContaining({ pid: expect.any(Number) })
      });

      await expect(rpc.request("release", {}, { timeoutMs: 2_000 })).resolves.toEqual({});
      await eventually(() => lateResponses.length === 1);
      expect(lateResponses[0]).toMatchObject({
        requestId: 1,
        method: "hold",
        timeoutMs: 25,
        lateResponseContext: { threadId: "safe-thread-id" },
        response: { id: 1, result: { released: true } }
      });
      expect(JSON.stringify(lateResponses[0])).not.toContain("request-params-are-not-retained");
      expect(lateResponses[0]!.receivedAt).toBeGreaterThanOrEqual(lateResponses[0]!.timedOutAt);

      await expect(rpc.request("echo", { still: "tracked" }, { timeoutMs: 2_000 })).resolves.toEqual({
        still: "tracked"
      });
    } finally {
      await rpc.close();
    }
  });

  it("validates explicit timeouts before spawning a process", async () => {
    const rpc = processFor();
    await expect(rpc.request("echo", {}, { timeoutMs: 0 })).rejects.toThrow(
      "JSON-RPC timeout must be an integer between 1"
    );
    await expect(
      rpc.request("echo", {}, {
        timeoutMs: 100,
        lateResponseContext: { threadId: "unsafe\nidentifier" }
      })
    ).rejects.toThrow("late-response context contains an invalid string identifier");
    expect(rpc.identity).toBeUndefined();
    await rpc.close();
  });

  it("clears pending requests as soon as process shutdown begins", async () => {
    const rpc = processFor({ omitJsonRpcHeader: true });
    const held = rpc.request("hold");
    await eventually(() => rpc.pendingRequestCount === 1);
    const rejected = expect(held).rejects.toThrow("process was closed");
    await rpc.close();
    await rejected;
    expect(rpc.pendingRequestCount).toBe(0);
  });

  it.each([
    ["resolve", "close"], ["reject", "close"], ["resolve", "exit"], ["reject", "exit"]
  ] as const)("handles an approval that %ss after process %s", async (outcome, stop) => {
    let finish!: () => void;
    let requested!: () => void;
    const arrived = new Promise<void>(resolve => { requested = resolve; });
    const rpc = processFor({
      onRequest: () => new Promise((resolve, reject) => {
        finish = () => outcome === "resolve" ? resolve({ decision: "accept" }) : reject(new Error("Approval dismissed"));
        requested();
      })
    });
    const running = rpc.request("ask-client");
    const rejected = expect(running).rejects.toThrow(stop === "close" ? "process was closed" : "exited");
    await arrived;
    if (stop === "close") await rpc.close();
    else await expect(rpc.request("exit-now")).rejects.toThrow("exited");
    finish();
    await rejected;
    // Let the detached inbound handler finish; Vitest also catches any
    // unhandled rejection that would terminate the production bridge process.
    await new Promise(resolve => setImmediate(resolve));
    expect(rpc.pendingRequestCount).toBe(0);
    await rpc.close();
  });

  it("leaves no pending state when the child command cannot start", async () => {
    const rpc = new JsonRpcProcess({
      command: `${process.execPath}-does-not-exist`,
      args: [],
      debugLabel: "missing-jsonrpc"
    });
    await expect(rpc.request("echo", {}, { timeoutMs: 100 })).rejects.toThrow();
    await eventually(() => rpc.exited);
    expect(rpc.pendingRequestCount).toBe(0);
    await rpc.close();
  });

  it.runIf(process.platform !== "win32")(
    "force-stops the exact detached process group, including descendants",
    async () => {
      const rpc = processFor({ omitJsonRpcHeader: true });
      const identity = await rpc.start();
      const { childPid } = await rpc.request<{ childPid: number }>("spawn-child", {}, { timeoutMs: 2_000 });
      expect(processAlive(identity.pid)).toBe(true);
      expect(processAlive(childPid)).toBe(true);

      const terminated = await rpc.forceTerminate(1_000);
      expect(terminated).toMatchObject({
        pid: identity.pid,
        processGroupId: identity.processGroupId,
        exited: true,
        mode: "process-group",
        workerExited: true
      });
      await eventually(() => !processAlive(childPid));
      expect(rpc.exited).toBe(true);
    }
  );

  it("rejects timer-free pending work when the supervised process exits", async () => {
    const exits: string[] = [];
    const rpc = processFor({
      omitJsonRpcHeader: true,
      onExit: (error) => exits.push(error.message)
    });
    const held = rpc.request("hold");
    const rejected = expect(held).rejects.toThrow(/exited/);
    await eventually(() => rpc.pendingRequestCount === 1);
    await rpc.forceTerminate(500);
    await rejected;
    expect(rpc.pendingRequestCount).toBe(0);
    expect(exits).toHaveLength(1);
  });

  it("nonforcing EOF verifies a real child exit and original group absence", async () => {
    const rpc=processFor(); await rpc.request("echo",{}, {timeoutMs:2000});
    const receipt=await rpc.close({allowSigkillEscalation:false,graceMs:1000});
    expect(receipt).toMatchObject({exited:true,outcome:"exited",survivors:0});
    expect(rpc.observeNonforcingExit()).toEqual(receipt);
  });

  it.runIf(process.platform!=="win32")("nonforcing parent exit retains a live group descendant", async () => {
    const rpc=processFor(); const identity=await rpc.start();
    const {childPid}=await rpc.request<{childPid:number}>("spawn-child",{}, {timeoutMs:2000});
    try {
      const receipt=await rpc.close({allowSigkillEscalation:false,graceMs:100});
      expect(receipt).toMatchObject({exited:false,outcome:"timeout",survivors:1});
      expect(rpc.exited).toBe(true); expect(processAlive(childPid)).toBe(true);
      expect(rpc.observeNonforcingExit().exited).toBe(false);
      // Independent test harness cleanup of its own synthetic descendant.
      // The tested nonforcing API must not perform this escalation itself.
      process.kill(childPid,"SIGTERM");
      await eventually(()=>!processAlive(childPid));
      await eventually(()=>rpc.observeNonforcingExit().exited);
      expect(await rpc.close({allowSigkillEscalation:false})).toBe(receipt);
      expect(identity.processGroupId).not.toBeNull();
    } finally {
      if (processAlive(childPid)) process.kill(childPid,"SIGKILL");
      await rpc.close();
    }
  });

  it("nonforcing stubborn child stays alive through a bounded timeout and cannot later escalate", async () => {
    const rpc=new JsonRpcProcess({command:process.execPath,args:["-e",
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'+FAKE_SERVER],debugLabel:"owned-stubborn-fixture"});
    const identity=await rpc.start(); await rpc.request("echo",{}, {timeoutMs:2000});
    try {
      const receipt=await rpc.close({allowSigkillEscalation:false,graceMs:25});
      expect(receipt).toMatchObject({exited:false,outcome:"timeout",survivors:1});
      expect(processAlive(identity.pid)).toBe(true);
      expect(await rpc.forceTerminate(1)).toMatchObject({exited:false,escalated:false,signal:null});
      expect(processAlive(identity.pid)).toBe(true);
      // Only the fixture owner may clean up after the verified timeout.
      process.kill(identity.pid,"SIGKILL");
      await eventually(()=>rpc.observeNonforcingExit().exited);
      expect(receipt.exited).toBe(false);
    } finally {
      if (processAlive(identity.pid)) process.kill(identity.pid,"SIGKILL");
      await rpc.close();
    }
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true before timeout.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
