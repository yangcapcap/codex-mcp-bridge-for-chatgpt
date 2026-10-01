import { snapshotExecutionShutdownRequest, type ExecutionShutdownRequest } from "./executionShutdownProtocol.js";
import { shutdownResult, type ShutdownResult } from "./shutdown.js";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const EXECUTION_FRAME_BYTES = 9 * 1024 * 1024;
const SOCKET_BUFFER_BYTES = 16 * 1024 * 1024;
export type ExecutionEndpoint = { directory: string; token: string };
type Owner = { pid: number; generation: string };
export type ExecutionOwnerShutdownBinding = Readonly<{generation:string;ownerPid:number;controllerId:string}>;

export function executionEndpoint(stateIdentity: string = randomUUID()): ExecutionEndpoint {
  const digest = createHash("sha256").update(stateIdentity).digest("hex").slice(0, 24);
  const directory = path.join(tmpdir(), `cmb-exec-${process.getuid?.() ?? "user"}-${digest}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" &&
      ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)))) {
    throw new Error("EXECUTION_ENDPOINT_UNSAFE: The execution directory is not private.");
  }
  const tokenFile = path.join(directory, "token");
  try { writeFileSync(tokenFile, randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const tokenInfo = lstatSync(tokenFile);
  if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || (process.platform !== "win32" && (tokenInfo.mode & 0o077))) {
    throw new Error("EXECUTION_ENDPOINT_UNSAFE: The execution token is not private.");
  }
  const token = readFileSync(tokenFile, "utf8");
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error("EXECUTION_ENDPOINT_INVALID");
  return { directory, token };
}

export function writeExecutionRecord(endpoint: ExecutionEndpoint, name: string, value: unknown): void {
  const file = path.join(endpoint.directory, name);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

export function readExecutionRecord<T>(endpoint: ExecutionEndpoint, name: string): T | undefined {
  try {
    const file = path.join(endpoint.directory, name);
    if (statSync(file).size > 64 * 1024 * 1024) throw new Error("EXECUTION_LEDGER_LIMIT");
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One bounded frame at a time. A broken/malformed link has no process authority. */
export class ExecutionSocket {
  private buffer = Buffer.alloc(0);
  private length?: number;
  constructor(readonly socket: Socket, receive: (value: any) => void) {
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (!socket.destroyed) {
        if (this.length === undefined) {
          if (this.buffer.length < 4) return;
          this.length = this.buffer.readUInt32BE(0);
          this.buffer = this.buffer.subarray(4);
          if (this.length === 0 || this.length > EXECUTION_FRAME_BYTES) { socket.destroy(); return; }
        }
        if (this.buffer.length < this.length) return;
        const frame = this.buffer.subarray(0, this.length);
        this.buffer = this.buffer.subarray(this.length);
        this.length = undefined;
        let value: unknown;
        try { value = JSON.parse(frame.toString("utf8")); }
        catch { socket.destroy(); return; }
        receive(value);
      }
    });
  }
  send(value: unknown, done: (error?: Error | null) => void = () => {}): boolean {
    let body: Buffer;
    try { body = Buffer.from(JSON.stringify(value)); }
    catch { done(new Error("EXECUTION_SERIALIZATION_FAILED")); return false; }
    return this.sendSerialized(body,done);
  }
  /** Transmit private, already serialized bytes without invoking caller code again. */
  sendSerialized(body: Buffer, done: (error?: Error | null) => void = () => {}): boolean {
    if (body.length===0 || body.length > EXECUTION_FRAME_BYTES) { done(new Error("EXECUTION_MESSAGE_TOO_LARGE")); return false; }
    if (this.socket.destroyed || this.socket.writableLength + body.length > SOCKET_BUFFER_BYTES) {
      done(new Error("EXECUTION_LINK_BACKPRESSURE"));
      return false;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([header, body]), done);
    return true;
  }
}

/** Reconnects only the control link. Missing heartbeat never kills an owner. */
export class ExecutionPeer extends EventEmitter {
  connected = false;
  pid?: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private socket?: ExecutionSocket;
  private process?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private launched = false;
  private owner?: Owner;
  private readonly controllerId = randomUUID();
  private nonforcingPinned=false;
  private nonforcingOwner?: Readonly<Owner>;
  private nonforcingProcess?: ChildProcess;
  private nonforcingOwnerChanged=false;
  private ordinaryShutdownSent=false;
  private nonforcingHistoryUncertain=false;
  private nonforcingCloseRequest?: Extract<ExecutionShutdownRequest,{type:"close-nonforcing"}>;
  private readonly outbound: Array<{ body: Buffer; callback(error?: Error | null): void }> = [];
  private outboundBytes = 0;
  private sending = false;

  constructor(readonly endpoint: ExecutionEndpoint,
    private readonly launch: { args: string[]; env: NodeJS.ProcessEnv; onStderr(text: string): void }) { super(); }

  /** Freeze the owner correlation and prohibit future launch/signal continuations. */
  pinNonforcingShutdown(): ExecutionOwnerShutdownBinding | undefined {
    if (!this.nonforcingPinned) {
      this.nonforcingPinned=true;
      this.nonforcingHistoryUncertain=this.ordinaryShutdownSent;
      if (this.owner && this.pid===this.owner.pid &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(this.owner.generation)) {
        this.nonforcingOwner=Object.freeze({...this.owner});
      }
      this.nonforcingProcess=this.process;
      const unsent=this.outbound.splice(0);this.outboundBytes=0;
      for (const pending of unsent) {
        try {pending.callback(new Error("NONFORCING_EXECUTION_CLOSED"));} catch { /* no process authority */ }
      }
    }
    return this.nonforcingBinding;
  }
  get nonforcingBinding(): ExecutionOwnerShutdownBinding | undefined {
    const owner=this.nonforcingOwner;
    if (!this.nonforcingPinned || !owner || this.nonforcingOwnerChanged) return;
    return Object.freeze({generation:owner.generation,ownerPid:owner.pid,controllerId:this.controllerId});
  }
  /** Only an actual retained owned child exit is proof here; a reattached lease is not. */
  observeNonforcingExit(): ShutdownResult {
    const binding=this.nonforcingBinding, child=this.nonforcingProcess;
    if (this.nonforcingHistoryUncertain || !binding || !child || child!==this.process || child.pid!==binding.ownerPid) return shutdownResult("uncertain");
    if (child.exitCode!==null || child.signalCode!==null) return shutdownResult("exited");
    return shutdownResult("timeout",1);
  }

  start(): void { this.connect(); }
  send(message: unknown, callback: (error?: Error | null) => void = () => {}): boolean {
    const pinnedAtStart=this.nonforcingPinned;
    let closeRequest:Extract<ExecutionShutdownRequest,{type:"close-nonforcing"}>|undefined;
    if (this.nonforcingPinned) {
      const request=snapshotExecutionShutdownRequest(message),binding=this.nonforcingBinding;
      const previous=this.nonforcingCloseRequest;
      if (!request || !binding || request.generation!==binding.generation || request.ownerPid!==binding.ownerPid ||
          request.controllerId!==binding.controllerId || request.type==="observe-nonforcing" &&
          (!previous || request.closeRequestId!==previous.requestId) || request.type==="close-nonforcing" &&
          previous && (request.requestId!==previous.requestId || request.policy.graceMs!==previous.policy.graceMs)) {
        callback(new Error("NONFORCING_EXECUTION_MESSAGE_REJECTED"));return false;
      }
      message=request;
      if (request.type==="close-nonforcing") closeRequest=request;
    }
    if (!this.connected || !this.socket) { callback(new Error("EXECUTION_DISCONNECTED")); return false; }
    let body:Buffer,wire:unknown;
    try {body=Buffer.from(JSON.stringify(message));wire=JSON.parse(body.toString("utf8"));}
    catch {callback(new Error("EXECUTION_SERIALIZATION_FAILED"));return false;}
    // Ordinary serialization may invoke getters/toJSON. A reentrant pin cannot
    // admit the ordinary message after the fence has already been installed.
    if (pinnedAtStart!==this.nonforcingPinned) {
      callback(new Error("NONFORCING_EXECUTION_MESSAGE_REJECTED"));return false;
    }
    if (!this.connected || !this.socket) {callback(new Error("EXECUTION_DISCONNECTED"));return false;}
    if (body.length===0 || body.length>EXECUTION_FRAME_BYTES) {
      callback(new Error("EXECUTION_MESSAGE_TOO_LARGE"));return false;
    }
    if (this.outbound.length >= 256 || this.outboundBytes + body.length > 40 * 1024 * 1024) {
      callback(new Error("EXECUTION_LINK_BACKPRESSURE"));
      // The proxy retains authoritative pending requests and replays their
      // original IDs after reconnect. Do not strand an unsent request forever.
      this.socket.socket.destroy();
      return false;
    }
    if (!pinnedAtStart && wire && typeof wire==="object" &&
        ["close","terminate-owner"].includes((wire as {type?:unknown}).type as string)) this.ordinaryShutdownSent=true;
    if (closeRequest && !this.nonforcingCloseRequest) this.nonforcingCloseRequest=closeRequest;
    this.outbound.push({ body, callback });
    this.outboundBytes += body.length;
    this.pump();
    return true;
  }
  private pump(): void {
    if (this.sending || !this.connected || !this.socket) return;
    const next = this.outbound.shift();
    if (!next) return;
    this.outboundBytes -= next.body.length;
    this.sending = true;
    const socket = this.socket;
    socket.sendSerialized(next.body, error => {
      if (this.socket !== socket) return;
      this.sending = false;
      next.callback(error);
      if (error) socket.socket.destroy();
      else this.pump();
    });
  }
  disconnect(): void { this.socket?.socket.destroy(); }
  detach(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.socket.destroy();
    this.connected = false;
    this.process?.unref();
  }
  kill(signal: NodeJS.Signals): boolean {
    if (this.nonforcingPinned) return false;
    this.ordinaryShutdownSent=true;
    if (this.process && this.process.exitCode === null && this.process.signalCode === null) return this.process.kill(signal);
    // A PID read from an old lease is not authority to signal a reused PID.
    // Reattached owners accept explicit termination on the authenticated link.
    return this.send({ type: "terminate-owner", signal });
  }
  private connect(): void {
    if (this.stopped || this.nonforcingPinned && (!this.nonforcingOwner || this.nonforcingOwnerChanged)) return;
    let authenticated = false;
    const socket = createConnection(executionSocketPath(this.endpoint));
    const framed = new ExecutionSocket(socket, value => {
      if (!authenticated) {
        if (value?.type !== "owner" || !Number.isSafeInteger(value.pid) || typeof value.generation !== "string") {
          socket.destroy(); return;
        }
        if (this.nonforcingPinned && (!this.nonforcingOwner || value.pid!==this.nonforcingOwner.pid ||
            value.generation!==this.nonforcingOwner.generation)) {
          this.nonforcingOwnerChanged=true;socket.destroy();return;
        }
        authenticated = true;
        this.owner = { pid: value.pid, generation: value.generation };
        this.pid = value.pid;
        this.connected = true;
        this.socket = framed;
        this.emit("connected");
        return;
      }
      this.emit("message", value);
    });
    socket.once("connect", () => framed.send({ type: "authenticate", token: this.endpoint.token, controllerId: this.controllerId }));
    socket.once("close", () => {
      if (this.socket === framed) {
        this.connected = false; this.socket = undefined; this.sending = false;
        this.outbound.length = 0; this.outboundBytes = 0;
        this.emit("disconnect");
      }
      if (this.stopped) return;
      if (this.nonforcingPinned) {
        // Reconnect only to the already captured owner. Never launch a replacement
        // or infer owned-child exit from a PID in an old lease.
        if (this.nonforcingOwner && !this.nonforcingOwnerChanged) {
          this.timer=setTimeout(()=>this.connect(),250);this.timer.unref();
        }
        return;
      }
      let owner: Owner | undefined;
      try { owner = readExecutionRecord<Owner>(this.endpoint, "owner.json") || this.owner; }
      catch {
        // Unreadable ownership evidence grants neither restart nor kill authority.
        this.timer = setTimeout(() => this.connect(), 2_000); this.timer.unref(); return;
      }
      if (owner && !alive(owner.pid)) {
        this.exitCode = 1;
        this.stopped = true;
        this.emit("exit", 1, null);
        return;
      }
      if (!owner && !this.launched) this.spawn();
      this.timer = setTimeout(() => this.connect(), 250);
      this.timer.unref();
    });
  }
  private spawn(): void {
    if (this.nonforcingPinned) return;
    this.launched = true;
    const child = this.process = spawn(process.execPath, this.launch.args, {
      cwd: process.cwd(), env: this.launch.env, detached: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    this.pid = child.pid;
    child.unref();
    child.stderr?.on("data", chunk => this.launch.onStderr(String(chunk)));
    // Do not keep the owner dependent on a pipe whose reader may disappear.
    (child.stderr as (NodeJS.ReadableStream & { unref?(): void }) | null)?.unref?.();
    child.on("error", error => this.emit("error", error));
    child.once("exit", (code, signal) => {
      if (this.stopped) return;
      let owner = this.owner;
      try { owner ||= readExecutionRecord<Owner>(this.endpoint, "owner.json"); } catch { /* direct child exit remains authoritative */ }
      if (owner && owner.pid !== child.pid) return; // another authenticated owner won the bind
      this.exitCode = code;
      this.signalCode = signal;
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      this.socket?.socket.destroy();
      this.connected = false;
      this.emit("exit", code, signal);
    });
  }
}

/** Called only after an actual owner exit, and after its retained trees are clean. */
export function clearExitedExecutionOwner(endpoint: ExecutionEndpoint): void {
  const owner = readExecutionRecord<Owner>(endpoint, "owner.json");
  if (owner && alive(owner.pid)) throw new Error("EXECUTION_OWNER_UNCONFIRMED");
  for (const file of ["owner.json", "control.sock", "trees.json"]) rmSync(path.join(endpoint.directory, file), { force: true });
}

export async function listenExecutionOwner(endpoint: ExecutionEndpoint, generation: string,
  handlers: { connected(send: (value: unknown, done?: (error?: Error | null) => void) => boolean, controllerId: string): void;
    disconnected(): void; message(value: any): void }): Promise<() => Promise<void>> {
  let current: ExecutionSocket | undefined;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    // Finite unauthenticated connections. No request is executed before auth.
    if (sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    let authenticated = false;
    const authTimer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5_000);
    authTimer.unref();
    const framed = new ExecutionSocket(socket, value => {
      if (!authenticated) {
        if (value?.type !== "authenticate" || value.token !== endpoint.token || typeof value.controllerId !== "string") { socket.destroy(); return; }
        authenticated = true;
        clearTimeout(authTimer);
        current?.socket.destroy();
        current = framed;
        framed.send({ type: "owner", pid: process.pid, generation });
        handlers.connected((message, done) => framed.send(message, done), value.controllerId);
      } else if (current === framed) handlers.message(value);
    });
    socket.on("close", () => {
      clearTimeout(authTimer); sockets.delete(socket);
      if (current === framed) { current = undefined; handlers.disconnected(); }
    });
  });
  const socketPath = executionSocketPath(endpoint);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  writeExecutionRecord(endpoint, "owner.json", { pid: process.pid, generation });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const owner = readExecutionRecord<Owner>(endpoint, "owner.json");
    if (owner?.generation === generation) {
      for (const file of ["owner.json", "control.sock"]) rmSync(path.join(endpoint.directory, file), { force: true });
    }
  };
}

function executionSocketPath(endpoint: ExecutionEndpoint): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\" + path.basename(endpoint.directory)
    : path.join(endpoint.directory, "control.sock");
}
