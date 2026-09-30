import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { assertJsonTextIntegrity, decodeUtf8Strict } from "./textIntegrity.js";
import { snapshotShutdownPolicy, shutdownResult, type ShutdownPolicy, type ShutdownResult } from "./shutdown.js";

type JsonRpcId = number;

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId | string;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (value: unknown) => void;
  timer?: NodeJS.Timeout;
};

type TimedOutRequest = {
  method: string;
  timeoutMs: number;
  timedOutAt: number;
  lateResponseContext?: JsonRpcLateResponseContext;
};

const MAX_TRACKED_TIMED_OUT_REQUESTS = 256;
export const MAX_JSON_RPC_TIMEOUT_MS = 2_147_483_647;
export const MAX_JSON_RPC_LINE_BYTES = 8 * 1024 * 1024;

export type JsonRpcProcessIdentity = {
  pid: number;
  processGroupId: number | null;
};

export type JsonRpcTerminationResult = JsonRpcProcessIdentity & {
  exited: boolean;
  escalated: boolean;
  signal: "SIGTERM" | "SIGKILL" | null;
  mode: "process-group" | "turn-interrupt" | "already-completed";
  workerExited: boolean;
};

export type JsonRpcRequestOptions = {
  /** Omit for a deliberately timer-free request. */
  timeoutMs?: number;
  progress?: boolean;
  onProgress?: (value: unknown) => void;
  /**
   * Bounded, non-sensitive identifiers needed to reconcile a response that
   * arrives after timeout. Request parameters are deliberately never retained.
   */
  lateResponseContext?: JsonRpcLateResponseContext;
};

export type JsonRpcLateResponseContext = Readonly<
  Record<string, string | number | boolean | null>
>;

export type JsonRpcLateResponse = TimedOutRequest & {
  requestId: number;
  receivedAt: number;
  /** The exact decoded response object received from the supervised process. */
  response: Readonly<Record<string, unknown>>;
};

export type JsonRpcServerRequestHandler = (
  method: string,
  params: unknown,
  requestId: number | string
) => Promise<unknown> | unknown;

export type JsonRpcNotificationHandler = (method: string, params: unknown) => void;

/**
 * Signals that the peer already resolved an inbound server request through a
 * separate protocol path. No duplicate JSON-RPC response must be written.
 */
export class JsonRpcServerRequestResolved extends Error {
  constructor() {
    super("The peer already resolved this server request.");
    this.name = "JsonRpcServerRequestResolved";
  }
}

export type JsonRpcProcessOptions = {
  command: string;
  args: string[];
  debugLabel: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onNotification?: JsonRpcNotificationHandler;
  onRequest?: JsonRpcServerRequestHandler;
  onExit?: (error: Error) => void;
  /**
   * Receives responses for recently timed-out requests. The transport retains
   * a bounded ledger so callers can correlate partial upstream success without
   * allowing abandoned request metadata to grow without limit.
   */
  onLateResponse?: (response: JsonRpcLateResponse) => void;
  /** Codex App Server uses JSON-RPC semantics but omits the jsonrpc header on the wire. */
  omitJsonRpcHeader?: boolean;
};

/**
 * Minimal newline-delimited JSON-RPC process transport.
 *
 * The MCP SDK deliberately installs a default request timer when no timeout is
 * supplied, and treats timeout=0 as an immediate timeout. Long-running Codex
 * turns need a different contract: no request deadline, while process lifetime
 * remains explicitly supervised. This transport creates a dedicated Unix
 * process group so force-stop can target the exact backend generation. A
 * separate process-tree supervisor retains descendants that create their own
 * groups and verifies those groups before a replacement worker is admitted.
 */
export class JsonRpcProcess {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly timedOut = new Map<JsonRpcId, TimedOutRequest>();
  private readonly inboundQueue: unknown[] = [];
  private inboundDrainScheduled = false;
  private pendingExitError?: Error;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private closing = false;
  private exitNotified = false;
  private nonforcingClose?: Promise<ShutdownResult>;
  private nonforcingObservation?: { child?: ChildProcessWithoutNullStreams;
    identity?: JsonRpcProcessIdentity; settled: boolean };

  constructor(private readonly options: JsonRpcProcessOptions) {}

  get identity(): JsonRpcProcessIdentity | undefined {
    const pid = this.child?.pid;
    if (!pid) return undefined;
    return {
      pid,
      processGroupId: process.platform === "win32" ? null : pid
    };
  }

  get exited(): boolean {
    return Boolean(
      this.exitNotified ||
      (this.child && (this.child.exitCode !== null || this.child.signalCode !== null))
    );
  }

  /** Diagnostic count used to assert lifecycle cleanup without exposing request payloads. */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

  async start(): Promise<JsonRpcProcessIdentity> {
    if (this.nonforcingClose) throw new Error(`${this.options.debugLabel} process is closed.`);
    if (this.child) {
      const identity = this.identity;
      if (!identity || this.exited) throw new Error(`${this.options.debugLabel} process is not running.`);
      return identity;
    }
    if (this.closing) throw new Error(`${this.options.debugLabel} process is closed.`);

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env || inheritedChildEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => this.receiveStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        process.stderr.write(`[${this.options.debugLabel}] ${chunk.toString()}`);
      }
    });

    const started = new Promise<JsonRpcProcessIdentity>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        const identity = this.identity;
        if (identity) resolve(identity);
        else reject(new Error(`${this.options.debugLabel} did not expose a process id.`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    child.once("exit", (code, signal) => {
      this.stdoutBuffer = Buffer.alloc(0);
      const suffix = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      this.notifyProcessExit(new Error(`${this.options.debugLabel} exited (${suffix}).`));
    });
    child.once("error", (error) => {
      this.notifyProcessExit(error);
    });

    return started;
  }

  async request<T = unknown>(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_JSON_RPC_TIMEOUT_MS)
    ) {
      throw new Error(
        `JSON-RPC timeout must be an integer between 1 and ${MAX_JSON_RPC_TIMEOUT_MS}ms when supplied.`
      );
    }
    const lateResponseContext = options.lateResponseContext
      ? boundedLateResponseContext(options.lateResponseContext)
      : undefined;
    await this.start();
    if (this.nonforcingClose) throw new Error(`${this.options.debugLabel} process is closed.`);
    const id = this.nextRequestId++;
    const requestParams = options.progress ? addProgressToken(params, id) : params;
    const promise = new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress: options.onProgress
      };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          const timedOutAt = Date.now();
          this.rememberTimedOutRequest(id, {
            method,
            timeoutMs,
            timedOutAt,
            ...(lateResponseContext ? { lateResponseContext } : {})
          });
          reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms (request ${id}).`), {
            code: -32001,
            requestId: id,
            method,
            timeoutMs,
            processIdentity: this.identity
          }));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
    });
    try {
      this.write({ jsonrpc: "2.0", id, method, ...(requestParams === undefined ? {} : { params: requestParams }) });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending?.timer) clearTimeout(pending.timer);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    if (this.nonforcingClose) throw new Error(`${this.options.debugLabel} process is closed.`);
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(graceMs?: number): Promise<void>;
  close(policy: ShutdownPolicy & { allowSigkillEscalation: false }): Promise<ShutdownResult>;
  close(policy: ShutdownPolicy): Promise<void | ShutdownResult>;
  async close(policyOrGrace: number | ShutdownPolicy = 1_500): Promise<void | ShutdownResult> {
    const policy = typeof policyOrGrace === "number" ? undefined : snapshotShutdownPolicy(policyOrGrace);
    const graceMs = policy ? policy.graceMs : policyOrGrace as number;
    if (this.nonforcingClose) return this.nonforcingClose;
    if (policy?.allowSigkillEscalation === false) {
      const child = this.child, identity = this.identity, alreadyClosing = this.closing;
      this.closing = true;
      this.rejectPending(new Error(`${this.options.debugLabel} process was closed.`));
      const observation = { child, identity, settled: false };
      this.nonforcingObservation = observation;
      // Pin the nonforcing decision synchronously, before any timeout/recovery
      // continuation can request escalation through this retained transport.
      return this.nonforcingClose = Promise.resolve().then(() =>
        this.closeNonforcing(child, identity, graceMs, alreadyClosing)).then(result => {
          observation.settled = !alreadyClosing; return result;
        });
    }
    if (this.closing) {
      await this.exitPromise;
      return;
    }
    this.closing = true;
    this.rejectPending(new Error(`${this.options.debugLabel} process was closed.`));
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // A closed stdin is already on the way out.
    }
    if (await this.waitForExit(graceMs)) return;
    await this.forceTerminate(graceMs);
  }

  async forceTerminate(graceMs = 1_500): Promise<JsonRpcTerminationResult> {
    if (this.nonforcingClose) {
      const result = await this.nonforcingClose;
      return { pid: this.identity?.pid || 0, processGroupId: this.identity?.processGroupId ?? null,
        exited: result.exited, workerExited: result.exited, escalated: false, signal: null, mode: "process-group" };
    }
    const identity = this.identity;
    if (!identity || this.exited) {
      return {
        pid: identity?.pid || 0,
        processGroupId: identity?.processGroupId ?? null,
        exited: true,
        escalated: false,
        signal: null,
        mode: "process-group",
        workerExited: true
      };
    }

    this.closing = true;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("Invalid termination grace period.");
    if (!processIdentityAlive(identity)) {
      return { ...identity, exited:true,workerExited:true,escalated:false,signal:null,mode:"process-group" };
    }
    signalExactProcess(identity, "SIGTERM");
    if (await waitForProcessIdentityExit(identity, graceMs)) {
      return { ...identity, exited:true,workerExited:true,escalated:false,signal:"SIGTERM",mode:"process-group" };
    }
    if (this.nonforcingClose) {
      return { ...identity, exited:false,workerExited:false,escalated:false,signal:"SIGTERM",mode:"process-group" };
    }
    signalExactProcess(identity,"SIGKILL");
    const exited=await waitForProcessIdentityExit(identity,graceMs);
    return { ...identity,exited,workerExited:exited,escalated:true,signal:"SIGKILL",mode:"process-group" };
  }

  observeNonforcingExit(): ShutdownResult {
    const observation = this.nonforcingObservation;
    if (!observation?.settled) return shutdownResult("uncertain");
    return this.nonforcingAbsence(observation.child, observation.identity);
  }

  private nonforcingAbsence(child: ChildProcessWithoutNullStreams | undefined,
    identity: JsonRpcProcessIdentity | undefined): ShutdownResult {
    if (!child) return this.child ? shutdownResult("uncertain",1,0,1) : shutdownResult("exited");
    if (!identity) return shutdownResult("uncertain",1);
    if (this.child !== child || child.pid !== identity.pid) return shutdownResult("uncertain",1,0,1);
    try {
      return shutdownResult(process.kill(identity.processGroupId ? -identity.processGroupId : identity.pid,0) === true ?
        "timeout" : "uncertain",1);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" &&
        (child.exitCode !== null || child.signalCode !== null) ? shutdownResult("exited") : shutdownResult("uncertain",1);
    }
  }

  private async closeNonforcing(child: ChildProcessWithoutNullStreams | undefined,
    identity: JsonRpcProcessIdentity | undefined, graceMs: number, alreadyClosing: boolean): Promise<ShutdownResult> {
    if (alreadyClosing) return shutdownResult("uncertain",child ? 1 : 0);
    if (!child) return shutdownResult("exited");
    if (!identity) return shutdownResult("uncertain",1);
    let failures = 0;
    const same = () => this.child === child && child.pid === identity.pid;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const wait = async (): Promise<ShutdownResult> => {
      const deadline = performance.now()+graceMs;
      do {
        const result = this.nonforcingAbsence(child,identity);
        if (result.outcome !== "timeout") return result;
        if (performance.now() >= deadline) return result;
        await delay(Math.min(25,Math.max(0,deadline-performance.now())));
      } while (true);
    };
    if (same() && !exited()) { try { child.stdin.end(); } catch { failures++; } }
    let result = await wait();
    if (result.outcome === "timeout" && same() && !exited()) {
      try { if (!child.kill("SIGTERM")) failures++; } catch { failures++; }
      result = await wait();
    }
    return failures ? shutdownResult("uncertain",result.survivors,failures,result.identityChanges) : result;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child || this.exited) return true;
    return Promise.race([
      (this.exitPromise || Promise.resolve()).then(() => true),
      delay(timeoutMs).then(() => false)
    ]);
  }

  private receiveStdout(chunk: Buffer): void {
    if (this.exitNotified || this.closing) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length > MAX_JSON_RPC_LINE_BYTES) {
          this.failWire(new Error(`${this.options.debugLabel} emitted an oversized JSON-RPC line.`));
        }
        return;
      }
      if (newline > MAX_JSON_RPC_LINE_BYTES) {
        this.failWire(new Error(`${this.options.debugLabel} emitted an oversized JSON-RPC line.`));
        return;
      }
      const lineBytes = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      let line: string;
      try {
        line = decodeUtf8Strict(lineBytes, `${this.options.debugLabel} stdout`);
      } catch (error) {
        this.failWire(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const error = this.handleLine(line);
      if (error) {
        this.failWire(error);
        return;
      }
    }
  }

  private handleLine(line: string): Error | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        process.stderr.write(`[${this.options.debugLabel}] ignored non-JSON stdout line\n`);
      }
      return undefined;
    }
    try {
      assertJsonTextIntegrity(message, `${this.options.debugLabel} response`);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (Array.isArray(message)) this.inboundQueue.push(...message);
    else this.inboundQueue.push(message);
    this.scheduleInboundDrain();
    return undefined;
  }

  private failWire(error: Error): void {
    if (this.exitNotified || this.closing) return;
    this.closing = true;
    this.stdoutBuffer = Buffer.alloc(0);
    const identity = this.identity;
    if (identity) {
      void this.forceTerminate(1_500).catch(() => undefined);
    }
    try {
      this.child?.stdin.end();
    } catch {
      // The transport has already become unusable.
    }
    this.notifyProcessExit(error);
  }

  /**
   * Process one wire message per microtask. Resolving an RPC response schedules
   * the awaiting caller before the next notification is consumed, so a server
   * may safely emit `turn/start`'s response and the first turn notifications in
   * one stdout chunk. Without this boundary, readline can synchronously deliver
   * every line before the caller has registered the returned turn id.
   */
  private scheduleInboundDrain(): void {
    if (this.inboundDrainScheduled) return;
    this.inboundDrainScheduled = true;
    queueMicrotask(() => this.drainInboundMessage());
  }

  private drainInboundMessage(): void {
    const message = this.inboundQueue.shift();
    if (message !== undefined) this.handleMessage(message);
    if (this.inboundQueue.length > 0) {
      queueMicrotask(() => this.drainInboundMessage());
      return;
    }
    this.inboundDrainScheduled = false;
    if (this.pendingExitError) {
      const error = this.pendingExitError;
      this.pendingExitError = undefined;
      this.finalizeProcessExit(error);
    }
  }

  private handleMessage(message: unknown): void {
    if (
      !isRecord(message) ||
      (message.jsonrpc !== "2.0" && !(this.options.omitJsonRpcHeader && message.jsonrpc === undefined))
    ) return;
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      void this.handleServerRequest(message as JsonRpcRequest);
      return;
    }
    if (typeof message.method === "string") {
      const notification = message as JsonRpcNotification;
      if (notification.method === "notifications/progress" && isRecord(notification.params)) {
        const token = notification.params.progressToken;
        if (typeof token === "number") this.pending.get(token)?.onProgress?.(notification.params);
      }
      this.options.onNotification?.(notification.method, notification.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.reportLateResponse(message.id, message);
      return;
    }
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      const rpcError = message.error as JsonRpcError;
      pending.reject(Object.assign(new Error(rpcError.message || "JSON-RPC request failed."), {
        code: rpcError.code,
        data: rpcError.data
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.canRespondToServer) return;
    try {
      if (!this.options.onRequest) {
        throw Object.assign(new Error(`Unsupported server request: ${request.method}`), { code: -32601 });
      }
      const result = await this.options.onRequest(request.method, request.params, request.id);
      // Approval/input handlers can settle after shutdown or a worker crash.
      // The response belongs to that dead connection and cannot be delivered.
      if (!this.canRespondToServer) return;
      this.write({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
    } catch (error) {
      if (error instanceof JsonRpcServerRequestResolved || !this.canRespondToServer) return;
      const code = isRecord(error) && typeof error.code === "number" ? error.code : -32603;
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private get canRespondToServer(): boolean {
    return !this.closing && !this.exited && this.child?.stdin.writable === true;
  }

  private write(message: unknown): void {
    if (!this.child || this.exited || !this.child.stdin.writable) {
      throw new Error(`${this.options.debugLabel} process stdin is unavailable.`);
    }
    assertJsonTextIntegrity(message, `${this.options.debugLabel} request`);
    const framed = this.options.omitJsonRpcHeader && isRecord(message)
      ? Object.fromEntries(Object.entries(message).filter(([key]) => key !== "jsonrpc"))
      : message;
    this.child.stdin.write(`${JSON.stringify(framed)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rememberTimedOutRequest(requestId: JsonRpcId, request: TimedOutRequest): void {
    this.timedOut.set(requestId, request);
    while (this.timedOut.size > MAX_TRACKED_TIMED_OUT_REQUESTS) {
      const oldest = this.timedOut.keys().next().value as JsonRpcId | undefined;
      if (oldest === undefined) break;
      this.timedOut.delete(oldest);
    }
  }

  private reportLateResponse(requestId: JsonRpcId, response: Record<string, unknown>): void {
    const request = this.timedOut.get(requestId);
    if (!request) return;
    this.timedOut.delete(requestId);
    try {
      this.options.onLateResponse?.({
        requestId,
        ...request,
        receivedAt: Date.now(),
        response
      });
    } catch (error) {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[${this.options.debugLabel}] late-response observer failed: ${message}\n`);
      }
    }
  }

  private notifyProcessExit(error: Error): void {
    if (this.exitNotified || this.pendingExitError) return;
    if (this.inboundDrainScheduled || this.inboundQueue.length > 0) {
      this.pendingExitError = error;
      return;
    }
    this.finalizeProcessExit(error);
  }

  private finalizeProcessExit(error: Error): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.rejectPending(error);
    this.timedOut.clear();
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.options.onExit?.(error);
  }
}

/**
 * Terminates a previously registered App Server identity without requiring the
 * supervising executor process to still be alive. On Unix the identity is a
 * dedicated process group. This primitive intentionally verifies that exact
 * group only; the execution service's process-tree ledger covers descendants
 * that move into another group.
 */
export async function terminateJsonRpcProcessIdentity(
  identity: JsonRpcProcessIdentity,
  graceMs = 1_500
): Promise<JsonRpcTerminationResult> {
  if (
    !Number.isSafeInteger(identity.pid) || identity.pid < 2 ||
    (identity.processGroupId !== null &&
      (!Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 2)) ||
    !Number.isSafeInteger(graceMs) || graceMs < 0
  ) {
    throw new Error("Invalid supervised process identity or termination grace period.");
  }
  if (!processIdentityAlive(identity)) {
    return {
      ...identity,
      exited: true,
      escalated: false,
      signal: null,
      mode: "process-group",
      workerExited: true
    };
  }
  signalExactProcess(identity, "SIGTERM");
  if (await waitForProcessIdentityExit(identity, graceMs)) {
    return {
      ...identity,
      exited: true,
      escalated: false,
      signal: "SIGTERM",
      mode: "process-group",
      workerExited: true
    };
  }
  signalExactProcess(identity, "SIGKILL");
  const exited = await waitForProcessIdentityExit(identity, graceMs);
  return {
    ...identity,
    exited,
    escalated: true,
    signal: "SIGKILL",
    mode: "process-group",
    workerExited: exited
  };
}

function addProgressToken(params: unknown, requestId: number): Record<string, unknown> {
  const base = isRecord(params) ? { ...params } : {};
  const meta = isRecord(base._meta) ? { ...base._meta } : {};
  meta.progressToken = requestId;
  base._meta = meta;
  return base;
}

function boundedLateResponseContext(
  value: JsonRpcLateResponseContext
): JsonRpcLateResponseContext {
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 8) {
    throw new Error("JSON-RPC late-response context must contain between 1 and 8 safe identifiers.");
  }
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of entries) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key) || key.length > 40) {
      throw new Error("JSON-RPC late-response context contains an invalid key.");
    }
    if (typeof entry === "string") {
      const identifier = entry.trim();
      if (!identifier || identifier.length > 200 || /[\u0000-\u001f\u007f]/.test(identifier)) {
        throw new Error("JSON-RPC late-response context contains an invalid string identifier.");
      }
      normalized[key] = identifier;
      continue;
    }
    if (
      entry === null ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isSafeInteger(entry))
    ) {
      normalized[key] = entry;
      continue;
    }
    throw new Error("JSON-RPC late-response context contains an unsupported value.");
  }
  return Object.freeze(normalized);
}

function inheritedChildEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "CODEX_HOME", "TMPDIR",
    "LANG", "LC_ALL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"
  ];
  return Object.fromEntries(
    keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])
  );
}

function signalExactProcess(identity: JsonRpcProcessIdentity, signal: NodeJS.Signals): void {
  try {
    if (identity.processGroupId !== null) process.kill(-identity.processGroupId, signal);
    else process.kill(identity.pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
  }
}

function processIdentityAlive(identity: JsonRpcProcessIdentity): boolean {
  try {
    if (identity.processGroupId !== null) process.kill(-identity.processGroupId, 0);
    else process.kill(identity.pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    if (isPermissionDenied(error)) return true;
    throw error;
  }
}

async function waitForProcessIdentityExit(
  identity: JsonRpcProcessIdentity,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processIdentityAlive(identity)) return true;
    await delay(25);
  } while (Date.now() < deadline);
  return !processIdentityAlive(identity);
}

function isNoSuchProcess(error: unknown): boolean {
  return isRecord(error) && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return isRecord(error) && error.code === "EPERM";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
