import { Transform, type Readable, type TransformCallback, type Writable } from "node:stream";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { BridgeConfig } from "./config.js";
import type { CodexModelCatalogProvider } from "./modelCatalog.js";
import { ScopeResolver } from "./scopeResolver.js";
import { createBridgeMcpServer, createModelCatalog } from "./server.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { BridgeStateStore } from "./stateStore.js";
import {RuntimeOperationFence} from "./runtimeOperationFence.js";
import {boundedShutdown,combineShutdown,snapshotShutdownPolicy,shutdownResult,type ShutdownPolicy,type ShutdownResult} from "./shutdown.js";
import {
  CodexJobRegistry,
  TaskProjectAvailabilityProjection,
  type BridgeApplicationService,
  type BridgeReadProjectionService
} from "./tools.js";
import type { CodexUpstream } from "./upstream.js";
import { UserSettingsStore } from "./userSettings.js";
import { assertJsonTextIntegrity, decodeUtf8Strict } from "./textIntegrity.js";
import type { BridgeTelemetryService } from "./telemetryService.js";

const MAX_STDIO_JSON_LINE_BYTES = 8 * 1024 * 1024;

export type BridgeStdioRuntimeOptions = {
  /** Shared production store; when supplied, its lifecycle remains caller-owned. */
  stateStore?: BridgeStateStore;
  /** Separate best-effort diagnostic sink; lifecycle remains caller-owned. */
  telemetry?: BridgeTelemetryService;
  /** Separate query process for structural Dashboard and Settings reads. */
  readProjection?: BridgeReadProjectionService;
  /** Optional catalog override used by deterministic integration tests. */
  modelCatalog?: CodexModelCatalogProvider;
  /** Custom streams used by byte-level stdio integration tests. */
  input?: Readable;
  output?: Writable;
  /** Observe an application failure without changing its protocol result. */
  onOperationFailure?: (error: unknown) => void;
  /** Dynamic execution-boundary admission; false rejects before a Job exists. */
  canAcceptNewJobs?: () => boolean;
};

export type BridgeStdioRuntime = {
  readonly applicationService: BridgeApplicationService;
  start(): Promise<void>;
  close(): Promise<void>;
  pinNonforcingShutdown():true;
  closeNonforcing(policy:ShutdownPolicy):Promise<ShutdownResult>;
  observeNonforcingExit():ShutdownResult;
};

/**
 * One modern MCP stdio connection for Secure MCP Tunnel's --mcp-command mode.
 * The tunnel owns the pipe; bridge state stays in the same durable stores as
 * HTTP and is never derived from a transport session identifier.
 */
export function createStdioBridgeRuntime(
  config: BridgeConfig,
  upstream: CodexUpstream,
  options: BridgeStdioRuntimeOptions = {}
): BridgeStdioRuntime {
  const stateStore = options.stateStore || new BridgeStateStore({
    file: config.stateDatabaseFile
  });
  const ownsStateStore = options.stateStore === undefined;
  const requestFence=new RuntimeOperationFence();
  const sessions = new SessionRegistry({
    stateStore,
    allowedRoots: config.allowedRoots,
    authBoundary: config.codexService ? () => config.codexService!.sessionAuthBoundary() : undefined
  });
  const jobs = new CodexJobRegistry({
    authBoundary: config.codexService ? () => config.codexService!.currentExecutionAuthBoundary() : undefined,
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: config.maxRetainedJobs,
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    stateStore,
    telemetry: options.telemetry,
    allowedRoots: config.allowedRoots
  });
  const userSettings = new UserSettingsStore(config, { stateStore });
  const scopeResolver = new ScopeResolver({ stateStore });
  const modelCatalog = options.modelCatalog || createModelCatalog(config, upstream);
  const projectAvailability = new TaskProjectAvailabilityProjection(config);
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessions,
    jobs,
    modelCatalog,
    userSettings,
    scopeResolver,
    projectAvailability,
    undefined,
    undefined,
    options.readProjection,
    options.onOperationFailure,
    false,
    options.canAcceptNewJobs,
    undefined,
    requestFence
  );
  // The SDK's stock stdio ReadBuffer calls Buffer.toString("utf8"), which
  // replaces malformed bytes. Feed it only complete, prevalidated JSON lines.
  const rawInput = options.input || process.stdin;
  const strictInput = new StrictJsonLineInput();
  rawInput.pipe(strictInput);
  const transport = new StdioServerTransport(strictInput, options.output);
  let handle: StdioServerHandle | undefined;
  let started = false;
  let closePromise: Promise<void> | undefined;
  let nonforcingClose:Promise<ShutdownResult>|undefined;
  let nonforcingUnknown=false;
  let resourcesClosed=false;
  let pinComplete=false;
  let pinFailed=false;
  const pin=():true=>{
    if(requestFence.isPinned){if(!pinComplete || pinFailed)throw new Error('NONFORCING_SHUTDOWN_PIN_UNCONFIRMED');return true;}
    requestFence.pinNonforcingShutdown();
    for(const fence of [()=>jobs.pinNonforcingShutdown(),()=>server.pinNonforcingShutdown(),()=>ownsStateStore?stateStore.pinNonforcingShutdown():true]) {
      try{if(fence()!==true)pinFailed=true;}catch{pinFailed=true;}
    }
    rawInput.unpipe(strictInput);strictInput.destroy();
    pinComplete=true;nonforcingUnknown ||= pinFailed;
    if(pinFailed)throw new Error('NONFORCING_SHUTDOWN_PIN_UNCONFIRMED');
    return true;
  };
  const observe=():ShutdownResult=>{
    if(!requestFence.isPinned || nonforcingUnknown)return shutdownResult('uncertain');
    const observed=combineShutdown([requestFence.observeNonforcingExit(),jobs.observeNonforcingExit(),server.observeNonforcingExit(),
      resourcesClosed && strictInput.destroyed && !server.isConnected()?shutdownResult('exited'):shutdownResult('timeout',1)]);
    if(!ownsStateStore)return observed;
    const database=observed.exited && resourcesClosed && nonforcingClose ? stateStore.closeNonforcing() : stateStore.observeNonforcingExit();
    return combineShutdown([observed,database]);
  };
  return {
    applicationService: server.applicationService,
    pinNonforcingShutdown:pin,
    observeNonforcingExit:observe,
    closeNonforcing(policy):Promise<ShutdownResult>{
      const supplied=snapshotShutdownPolicy(policy);
      if(supplied.allowSigkillEscalation!==false)throw new Error('NONFORCING_SHUTDOWN_POLICY_REQUIRED');
      if(nonforcingClose)return nonforcingClose;
      let seal!:(result:ShutdownResult)=>void;
      nonforcingClose=new Promise(resolve=>{seal=resolve;});
      try{pin();}catch{nonforcingUnknown=true;seal(shutdownResult('uncertain'));return nonforcingClose;}
      const resources=Promise.allSettled([()=>handle?.close(),()=>server.close(),()=>jobs.closeThreadConnections()]
        .map(close=>Promise.resolve().then(close))).then(results=>{
        if(results.some(result=>result.status==='rejected'))nonforcingUnknown=true;
        resourcesClosed=true;
        if(ownsStateStore && observe().exited && !stateStore.closeNonforcing().exited)nonforcingUnknown=true;
      });
      void boundedShutdown(async()=>{
        let timer:NodeJS.Timeout|undefined;
        try{await Promise.race([resources,new Promise<void>(resolve=>{timer=setTimeout(resolve,supplied.graceMs);})]);}
        finally{if(timer)clearTimeout(timer);}
        return observe();
      },supplied.graceMs+6000).then(seal,()=>seal(shutdownResult('uncertain')));
      return nonforcingClose;
    },
    async start(): Promise<void> {
      requestFence.assertAdmission();
      if (started) throw new Error("MCP stdio bridge is already started.");
      started = true;
      stateStore.markServiceOpen("stdio");
      handle = serveStdio(
        () => server,
        {
          legacy: "reject",
          transport,
          onerror: (error) => {
            try {
              options.onOperationFailure?.(error);
            } catch {
              // Readiness observation cannot replace the request error.
            }
            logStdioError(error);
          }
        }
      );
    },
    close(): Promise<void> {
      if(requestFence.isPinned)return (nonforcingClose ?? Promise.resolve(shutdownResult('uncertain'))).then(result=>{
        if(!result.exited)throw new Error('NONFORCING_SHUTDOWN_UNCONFIRMED');
      });
      if (!closePromise) {
        requestFence.markOrdinaryClose();
        closePromise = Promise.all([
          handle?.close(),
          server.close(),
          jobs.closeThreadConnections()
        ]).then(() => {
          rawInput.unpipe(strictInput);
          strictInput.destroy();
          if (ownsStateStore) stateStore.close();
        });
      }
      return closePromise;
    }
  };
}

/**
 * Preserve the SDK's framed JSON-RPC behavior while checking a full raw line
 * before it reaches the SDK's lossy UTF-8 conversion.
 */
class StrictJsonLineInput extends Transform {
  private buffer = Buffer.alloc(0);

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > MAX_STDIO_JSON_LINE_BYTES) {
      callback(new Error("MCP stdio request exceeded the UTF-8 frame limit."));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const text = decodeUtf8Strict(line, "MCP stdio request");
        if (text.trim()) {
          try {
            const parsed = JSON.parse(text);
            assertJsonTextIntegrity(parsed, "MCP stdio request");
          } catch (error) {
            // Preserve the SDK's existing behavior for structurally invalid
            // JSON lines, but never allow a text-integrity failure through.
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.push(Buffer.concat([line, Buffer.from("\n")]));
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.buffer.length > 0) {
        decodeUtf8Strict(this.buffer, "MCP stdio request");
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function logStdioError(error: unknown): void {
  if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
    console.error("MCP stdio request failed:", error);
  } else {
    console.error("MCP stdio request failed. Set CODEX_MCP_BRIDGE_DEBUG=1 for local diagnostics.");
  }
}
