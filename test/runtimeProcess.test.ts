import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  createIsolatedHttpServer,
  createIsolatedStdioRuntime
} from "../src/runtimeProcess.js";
import type { BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { syntheticIdToken } from "./fixtures/syntheticAuth.js";

type RunningRuntime = {
  root: string;
  server: BridgeHttpServer;
  baseUrl: string;
};

const running: RunningRuntime[] = [];
const CURRENT_PROTOCOL = "2026-07-28";

afterEach(async () => {
  for (const item of running.splice(0)) {
    await new Promise<void>(resolve => item.server.close(() => resolve()));
    await rm(item.root, { recursive: true, force: true });
  }
});

async function start(
  onRuntimeProcessSpawn?: (processId: number) => void,
  restartStartupTimeoutMs?: number,
  environmentOverrides: NodeJS.ProcessEnv = {},
  conformanceFixtures = false,
  onExecutionProcessSpawn?: (processId: number) => void
): Promise<RunningRuntime> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-runtime-process-"));
  const environment = { ...runtimeEnvironment(root), ...environmentOverrides };
  if (environmentOverrides.CODEX_TEST_RUNTIME_AUTH_FIXTURE === "1") {
    environment.CODEX_HOME = path.join(root, "fixture-auth");
    await mkdir(environment.CODEX_HOME, { mode: 0o700 });
    await writeFile(path.join(environment.CODEX_HOME, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt", tokens: { account_id: "synthetic-runtime-account",
        id_token: syntheticIdToken("fixture-runtime-user", "synthetic-runtime-account") }
    }), { mode: 0o600 });
  }
  const server = await createIsolatedHttpServer(loadConfig(environment), {
    childEnvironment: environment,
    onRuntimeProcessSpawn,
    onExecutionProcessSpawn,
    restartStartupTimeoutMs,
    conformanceFixtures
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address.");
  const item = {
    root,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
  running.push(item);
  return item;
}

function conformanceToolCall(baseUrl: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL,
      "mcp-method": "tools/call",
      "mcp-name": "test_logging_tool"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomRequestId(),
      method: "tools/call",
      params: {
        name: "test_logging_tool",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "runtime-process-regression",
            version: "1.0.0"
          },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    }),
    signal
  });
}

function randomRequestId(): string {
  return `runtime-process-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function runtimeEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
    CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json"),
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: path.join(root, "skills")
  };
}

async function waitUntilReady(baseUrl: string, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(`${baseUrl}/readyz`);
    if (response.status === 200) return response;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Runtime did not recover: ${await response?.text()}`);
}

async function waitUntilCapacity(baseUrl: string, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(`${baseUrl}/readyz`);
    if (response.status === 503) {
      const body = await response.clone().json() as { reason?: string };
      if (body.reason === "state-capacity") return response;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Runtime did not report capacity: ${await response?.text()}`);
}

async function observedStateInFlight(baseUrl: string): Promise<number | undefined> {
  const response = await fetch(`${baseUrl}/readyz`);
  const body = await response.json() as { stateService?: { inFlight?: number } };
  return body.stateService?.inFlight;
}

async function waitForRuntimeHealth(
  applicationService: BridgeHttpServer["applicationService"],
  stateStatus: string,
  timeoutMs = 8_000,
  additional: () => boolean = () => true
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      applicationService.runtimeHealth?.().stateService?.status === stateStatus &&
      additional()
    ) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    `Runtime health did not reach ${stateStatus}: ` +
    JSON.stringify(applicationService.runtimeHealth?.())
  );
}

function openIncompleteMcpRequest(
  baseUrl: string,
  declaredLength?: number
): Promise<Socket> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = createConnection(Number(url.port), url.hostname);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      socket.write(
        `POST /mcp HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        "Content-Type: application/json\r\n" +
        (declaredLength === undefined
          ? "Transfer-Encoding: chunked\r\n"
          : `Content-Length: ${declaredLength}\r\n`) +
        "Connection: keep-alive\r\n\r\n" +
        (declaredLength === undefined ? "1\r\n{\r\n" : "{")
      );
      resolve(socket);
    });
  });
}

function postMcpChunks(
  baseUrl: string,
  chunks: readonly Buffer[],
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }
    }, response => {
      const received: Buffer[] = [];
      response.on("data", (chunk: Buffer) => received.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve({ status: response.statusCode || 0,
            body: JSON.parse(Buffer.concat(received).toString("utf8")) as Record<string, unknown> });
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    void (async () => {
      for (const chunk of chunks) {
        request.write(chunk);
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      request.end();
    })().catch(reject);
  });
}

async function connectTaskClient(baseUrl: string): Promise<{
  client: Client;
  taskArguments(): Record<string, unknown>;
}> {
  const client = new Client(
    { name: "runtime-storage-admission", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: CURRENT_PROTOCOL } } }
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  const descriptor = (await client.listTools()).tools.find(
    tool => tool.name === "codex_task"
  );
  if (!descriptor) {
    await client.close();
    throw new Error("codex_task descriptor is unavailable.");
  }
  const properties = descriptor.inputSchema.properties as Record<
    string,
    { const?: string | number }
  >;
  const scopeId = randomUUID();
  return {
    client,
    taskArguments: () => ({
      scopeId,
      requestId: randomUUID(),
      taskContractVersion: properties.taskContractVersion?.const,
      executionEnvelopeRef: properties.executionEnvelopeRef?.const,
      prompt: "This task must not be admitted while state storage is unavailable."
    })
  };
}

async function primeTaskScope(
  runtime: RunningRuntime,
  taskClient: Awaited<ReturnType<typeof connectTaskClient>>
): Promise<void> {
  const preflight = await taskClient.client.callTool({
    name: "codex_task",
    arguments: taskClient.taskArguments()
  });
  expect(preflight.isError).toBe(true);
  expect(preflight.structuredContent).toMatchObject({ jobId: null });
  expect(JSON.stringify(preflight)).not.toContain("STATE_STORAGE_UNAVAILABLE");
  const inspection = new Database(path.join(runtime.root, "state.sqlite"), {
    readonly: true
  });
  try {
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM jobs").get())
      .toEqual({ count: 0 });
  } finally {
    inspection.close();
  }
}

async function expectTaskStorageUnavailable(
  runtime: RunningRuntime,
  taskClient: Awaited<ReturnType<typeof connectTaskClient>>
): Promise<void> {
  const blocked = await taskClient.client.callTool({
    name: "codex_task",
    arguments: taskClient.taskArguments()
  });
  expect(blocked.isError).toBe(true);
  expect(blocked.structuredContent).toMatchObject({
    jobId: null,
    error: {
      code: "STATE_STORAGE_UNAVAILABLE",
      retryable: true
    }
  });
  const inspection = new Database(path.join(runtime.root, "state.sqlite"), {
    readonly: true
  });
  try {
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM jobs").get())
      .toEqual({ count: 0 });
  } finally {
    inspection.close();
  }
}

describe("isolated production runtime", () => {
  it("supervises Codex execution separately from the operational state owner", async () => {
    const stateProcessIds: number[] = [];
    const executionProcessIds: number[] = [];
    const runtime = await start(
      processId => stateProcessIds.push(processId),
      undefined,
      {
        CODEX_MCP_BRIDGE_CODEX: path.join(
          process.cwd(),
          "test/fixtures/fake-codex-app-server.mjs"
        )
      },
      false,
      processId => executionProcessIds.push(processId)
    );

    await expect(runtime.server.applicationService.dashboardSnapshot({
      inspectRuntime: true
    })).resolves.toMatchObject({ codexAccount: expect.any(Object) });
    await waitForRuntimeHealth(
      runtime.server.applicationService,
      "ready",
      8_000,
      () => executionProcessIds.length === 1 &&
        runtime.server.applicationService.runtimeHealth?.().executionService?.status === "ready"
    );
    expect(stateProcessIds).toHaveLength(1);
    expect(executionProcessIds[0]).not.toBe(stateProcessIds[0]);
    expect(execFileSync("ps", ["-p", String(executionProcessIds[0]), "-o", "command="], {
      encoding: "utf8"
    })).toContain("Codex MCP Bridge Execution");

    const taskClient = await connectTaskClient(runtime.baseUrl);
    let executionStopped = false;
    try {
      process.kill(executionProcessIds[0]!, "SIGSTOP");
      executionStopped = true;
      await waitForRuntimeHealth(
        runtime.server.applicationService,
        "ready",
        8_000,
        () => runtime.server.applicationService.runtimeHealth?.().executionService?.heartbeatStatus === "delayed"
      );
      const available = await fetch(`${runtime.baseUrl}/readyz`);
      expect(available.status).toBe(200);
      await expect(runtime.server.applicationService.runtimeSnapshot()).resolves.toMatchObject({ acceptingNewJobs: true });
      expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
        stateService: { status: "ready" },
        executionService: { status: "ready", heartbeatStatus: "delayed" }
      });
    } finally {
      if (executionStopped) process.kill(executionProcessIds[0]!, "SIGCONT");
      await taskClient.client.close();
    }
    await waitForRuntimeHealth(
      runtime.server.applicationService,
      "ready",
      8_000,
      () => runtime.server.applicationService.runtimeHealth?.().executionService?.status === "ready"
    );

    process.kill(executionProcessIds[0]!, "SIGKILL");
    await waitForRuntimeHealth(
      runtime.server.applicationService,
      "ready",
      12_000,
      () => executionProcessIds.length >= 2 &&
        runtime.server.applicationService.runtimeHealth?.().executionService?.status === "ready"
    );
    expect(stateProcessIds).toHaveLength(1);
    await expect(runtime.server.applicationService.runtimeSnapshot()).resolves.toMatchObject({
      acceptingNewJobs: true
    });
    expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
      stateService: { status: "ready" },
      executionService: { status: "ready" }
    });
    expect(await fetch(`${runtime.baseUrl}/healthz`).then(response => response.status)).toBe(200);
  }, 25_000);

  it("keeps liveness responsive, reports a blocked write, and recovers after the DB lock", async () => {
    const runtime = await start();
    const initialReady = await fetch(`${runtime.baseUrl}/readyz`);
    expect(initialReady.status).toBe(200);
    await expect(runtime.server.applicationService.dashboardSnapshot({
      inspectRuntime: false
    })).resolves.toMatchObject({
      statusRows: expect.any(Array),
      enrichment: { state: "structural" }
    });
    expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
      readService: { status: "ready" }
    });
    await runtime.server.applicationService.beginDrain();
    const drainDeadline = Date.now() + 2_000;
    while (
      runtime.server.applicationService.runtimeHealth?.().acceptingNewJobs !== false &&
      Date.now() < drainDeadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
      acceptingNewJobs: false,
      stateService: { status: "ready" }
    });
    await expect(fetch(`${runtime.baseUrl}/readyz`).then(response => response.json()))
      .resolves.toMatchObject({ reason: "admission-draining" });
    await runtime.server.applicationService.cancelDrain();
    await waitUntilReady(runtime.baseUrl);

    const current = await runtime.server.applicationService.settingsSnapshot();
    const databaseFile = path.join(runtime.root, "state.sqlite");
    const locker = new Database(databaseFile);
    locker.exec("BEGIN IMMEDIATE");

    const mutation = runtime.server.applicationService.updateSettings({
        expectedSettingsRevision: current.settings.settingsRevision,
        operation: {
          kind: "patch",
          settings: {
            showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
          }
        }
      }).then(
        () => ({ ok: true as const, error: "" }),
        error => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    const queuedMcp = fetch(`${runtime.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "queued-during-lock", method: "ping" })
    });
    let mutationSettled = false;
    void mutation.then(() => { mutationSettled = true; });

    try {
      await new Promise(resolve => setTimeout(resolve, 2_400));
      expect(mutationSettled).toBe(false);
      const livenessStartedAt = Date.now();
      const liveness = await fetch(`${runtime.baseUrl}/healthz`);
      expect(liveness.status).toBe(200);
      expect(Date.now() - livenessStartedAt).toBeLessThan(500);

      const readiness = await fetch(`${runtime.baseUrl}/readyz`);
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toMatchObject({
        ok: false,
        reason: "state-stale",
        limitations: ["state-write-unconfirmed"],
        stateService: {
          activeOperation: {
            access: "write",
            operation: "state-transaction",
            phase: "write-lock-wait"
          }
        }
      });

      expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
        acceptingNewJobs: false,
        backgroundProcessState: "unknown",
        readService: { status: "read-stale" },
        telemetryService: { status: "stale" },
        stateService: {
          status: "state-stale",
          activeOperation: {
            access: "write",
            phase: "write-lock-wait"
          }
        }
      });
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }

    expect(await mutation).toMatchObject({ ok: true });
    const queuedResponse = await queuedMcp;
    expect(queuedResponse.status).not.toBe(503);
    const recovered = await waitUntilReady(runtime.baseUrl);
    expect(await recovered.json()).toMatchObject({ ok: true, reason: "ready" });
    await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: { settingsRevision: current.settings.settingsRevision + 1 }
    });
  }, 15_000);

  it("keeps the stdio companion boundary responsive during the same DB lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-runtime-stdio-"));
    const environment = runtimeEnvironment(root);
    const input = new PassThrough();
    const output = new PassThrough();
    const processIds: number[] = [];
    output.resume();
    const runtime = await createIsolatedStdioRuntime(loadConfig(environment), {
      childEnvironment: environment,
      input,
      output,
      onRuntimeProcessSpawn: processId => processIds.push(processId)
    });
    const current = await runtime.applicationService.settingsSnapshot();
    const locker = new Database(path.join(root, "state.sqlite"));
    try {
      locker.exec("BEGIN IMMEDIATE");
      const mutation = runtime.applicationService.updateSettings({
          expectedSettingsRevision: current.settings.settingsRevision,
          operation: {
            kind: "patch",
            settings: {
              showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
            }
          }
        });
      try {
        await new Promise(resolve => setTimeout(resolve, 2_400));
        expect(runtime.applicationService.runtimeHealth?.()).toMatchObject({
          acceptingNewJobs: false,
          stateService: {
            status: "state-stale",
            activeOperation: { access: "write", phase: "write-lock-wait" }
          }
        });
      } finally {
        locker.exec("ROLLBACK");
        locker.close();
      }
      await expect(mutation).resolves.toMatchObject({
        settings: { settingsRevision: current.settings.settingsRevision + 1 }
      });

      await waitForRuntimeHealth(runtime.applicationService, "ready");
      expect(processIds).toHaveLength(1);
      process.kill(processIds[0]!, "SIGKILL");
      await waitForRuntimeHealth(runtime.applicationService, "ready", 12_000, () =>
        processIds.length >= 2
      );
      await expect(runtime.applicationService.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: current.settings.settingsRevision + 1 }
      });
    } finally {
      if (locker.open) locker.close();
      await runtime.close();
      input.end();
      output.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("fails admission after SQLite reports a full state database", async () => {
    const runtime = await start(undefined, undefined, {
      NODE_ENV: "test",
      CODEX_MCP_BRIDGE_TEST_FREEZE_STATE_PAGE_COUNT: "1"
    });
    const taskClient = await connectTaskClient(runtime.baseUrl);
    const current = await runtime.server.applicationService.settingsSnapshot();
    try {
      await primeTaskScope(runtime, taskClient);
      const descriptions = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
        `model-${index.toString().padStart(3, "0")}`,
        `${index}:`.padEnd(600, "x")
      ]));
      await expect(runtime.server.applicationService.updateSettings({
        expectedSettingsRevision: current.settings.settingsRevision,
        operation: {
          kind: "patch",
          settings: { modelDescriptionOverrides: descriptions }
        }
      })).rejects.toThrow(/STATE_STORAGE_FULL|database or disk is full/iu);

      await waitForRuntimeHealth(
        runtime.server.applicationService,
        "state-recovering",
        8_000,
        () => runtime.server.applicationService.runtimeHealth?.().stateService?.storageError ===
          "full"
      );
      expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
        acceptingNewJobs: false,
        stateService: {
          status: "state-recovering",
          storageError: "full",
          storageErrorObservedAt: expect.any(Number)
        }
      });
      const degraded = await fetch(`${runtime.baseUrl}/readyz`);
      expect(degraded.status).toBe(503);
      await expect(degraded.json()).resolves.toMatchObject({
        reason: "state-recovering",
        limitations: ["state-storage-full"],
        stateService: { storageError: "full" }
      });
      await expectTaskStorageUnavailable(runtime, taskClient);
    } finally {
      await taskClient.client.close();
    }
  }, 15_000);

  it("reports a SQLite busy failure at transaction admission and clears it after a commit", async () => {
    const runtime = await start();
    const current = await runtime.server.applicationService.settingsSnapshot();
    const locker = new Database(path.join(runtime.root, "state.sqlite"));
    try {
      locker.exec("BEGIN IMMEDIATE");

      const blockedMutation = runtime.server.applicationService.updateSettings({
        expectedSettingsRevision: current.settings.settingsRevision,
        operation: {
          kind: "patch",
          settings: {
            showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
          }
        }
      }).catch(error => error);

      try {
        await waitForRuntimeHealth(
          runtime.server.applicationService,
          "state-capacity",
          8_000,
          () => runtime.server.applicationService.runtimeHealth?.().stateService?.storageError ===
            "busy"
        );
        expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
          acceptingNewJobs: false,
          stateService: {
            status: "state-capacity",
            storageError: "busy",
            storageErrorObservedAt: expect.any(Number)
          }
        });
        const degraded = await fetch(`${runtime.baseUrl}/readyz`);
        expect(degraded.status).toBe(503);
        await expect(degraded.json()).resolves.toMatchObject({
          reason: "state-capacity",
          limitations: ["state-storage-busy"],
          stateService: { storageError: "busy" }
        });
      } finally {
        locker.exec("ROLLBACK");
        locker.close();
      }

      await expect(blockedMutation).resolves.toBeInstanceOf(Error);
      await expect(runtime.server.applicationService.updateSettings({
        expectedSettingsRevision: current.settings.settingsRevision,
        operation: {
          kind: "patch",
          settings: {
            showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
          }
        }
      })).resolves.toMatchObject({
        settings: { settingsRevision: current.settings.settingsRevision + 1 }
      });
      await waitUntilReady(runtime.baseUrl);
    } finally {
      if (locker.open) locker.close();
    }
  }, 20_000);

  it.each([
    ["SQLITE_BUSY", "busy"],
    ["SQLITE_IOERR_FSYNC", "io"],
    ["SQLITE_CORRUPT_VTAB", "corrupt"],
    ["SQLITE_READONLY_DBMOVED", "read-only"]
  ] as const)(
    "fails actual Job admission after a non-transaction task read surfaces %s",
    async (driverCode, storageError) => {
      const degradedStatus = storageError === "busy"
        ? "state-capacity"
        : "state-recovering";
      const turnLog = path.join(
        tmpdir(),
        `bridge-runtime-turns-${randomUUID()}.log`
      );
      const runtime = await start(undefined, undefined, {
        NODE_ENV: "test",
        CODEX_MCP_BRIDGE_CODEX: path.join(
          process.cwd(),
          "test/fixtures/fake-codex-app-server.mjs"
        ),
        CODEX_TEST_TURN_LOG: turnLog,
        CODEX_MCP_BRIDGE_TEST_TASK_READ_STORAGE_ERROR: driverCode
      }, true);
      const settingsInspection = new Database(path.join(runtime.root, "state.sqlite"), {
        readonly: true
      });
      let settingsRevision = 0;
      try {
        const row = settingsInspection
          .prepare("SELECT settings_revision FROM user_settings WHERE singleton = 1")
          .get() as { settings_revision: number } | undefined;
        settingsRevision = row?.settings_revision || 0;
      } finally {
        settingsInspection.close();
      }
      const taskClient = await connectTaskClient(runtime.baseUrl);
      try {
        const surfaced = await taskClient.client.callTool({
          name: "codex_task",
          arguments: taskClient.taskArguments()
        });
        expect(surfaced.isError).toBe(true);

        await waitForRuntimeHealth(
          runtime.server.applicationService,
          degradedStatus,
          8_000,
          () => runtime.server.applicationService.runtimeHealth?.().stateService?.storageError ===
            storageError
        );
        expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
          acceptingNewJobs: false,
          stateService: {
            status: degradedStatus,
            storageError,
            storageErrorObservedAt: expect.any(Number)
          }
        });
        const degraded = await fetch(`${runtime.baseUrl}/readyz`);
        expect(degraded.status).toBe(503);
        await expect(degraded.json()).resolves.toMatchObject({
          reason: degradedStatus,
          limitations: [`state-storage-${storageError}`]
        });

        await expectTaskStorageUnavailable(runtime, taskClient);
        const turns = await readFile(turnLog, "utf8").catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        });
        expect(turns).toBe("");

        await expect(runtime.server.applicationService.updateSettings({
          expectedSettingsRevision: settingsRevision,
          operation: {
            kind: "patch",
            settings: {
              showBridgeThreadsInCodexApp: false
            }
          }
        })).resolves.toMatchObject({
          settings: { settingsRevision: settingsRevision + 1 }
        });
        await waitUntilReady(runtime.baseUrl);
        const recovered = await taskClient.client.callTool({
          name: "codex_task",
          arguments: taskClient.taskArguments()
        });
        expect(JSON.stringify(recovered)).not.toContain("STATE_STORAGE_UNAVAILABLE");
      } finally {
        await taskClient.client.close();
        await rm(turnLog, { force: true });
      }
    },
    20_000
  );

  it("preserves a forwarded MCP request through a stale heartbeat", async () => {
    const processIds: number[] = [];
    const runtime = await start(
      processId => processIds.push(processId),
      undefined,
      {
        NODE_ENV: "test",
        CODEX_MCP_BRIDGE_TEST_CONFORMANCE_DELAY_MS: "5000"
      },
      true
    );
    const pending = conformanceToolCall(runtime.baseUrl);
    const forwardingDeadline = Date.now() + 2_000;
    let forwarded = false;
    while (!forwarded && Date.now() < forwardingDeadline) {
      const readiness = await fetch(`${runtime.baseUrl}/readyz`).then(response => response.json()) as {
        stateService?: { inFlight?: number };
      };
      forwarded = (readiness.stateService?.inFlight || 0) >= 1;
      if (forwarded) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(forwarded).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(processIds).toHaveLength(1);

    let stopped = false;
    try {
      process.kill(processIds[0]!, "SIGSTOP");
      stopped = true;
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 2_400));
      expect(settled).toBe(false);
      expect(await fetch(`${runtime.baseUrl}/readyz`).then(response => response.status)).toBe(503);
    } finally {
      if (stopped) process.kill(processIds[0]!, "SIGCONT");
    }

    expect((await pending).status).toBe(200);
    await waitUntilReady(runtime.baseUrl);
  }, 15_000);

  it("preserves a complete split UTF-8 ID when the forwarded response is lost", async () => {
    const processIds: number[] = [];
    const runtime = await start(
      processId => processIds.push(processId), undefined,
      { NODE_ENV: "test", CODEX_MCP_BRIDGE_TEST_CONFORMANCE_DELAY_MS: "5000" }, true
    );
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: "한글", method: "tools/call",
      params: { name: "test_logging_tool", arguments: {}, _meta: {
        "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "split-id-regression", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {}
      } }
    }));
    const splitAt = Buffer.byteLength('{"jsonrpc":"2.0","id":"') + 1;
    const pending = postMcpChunks(runtime.baseUrl,
      [body.subarray(0, splitAt), body.subarray(splitAt)], {
        accept: "application/json",
        "mcp-protocol-version": CURRENT_PROTOCOL,
        "mcp-method": "tools/call",
        "mcp-name": "test_logging_tool"
      });
    const deadline = Date.now() + 2_000;
    let forwarded = false;
    while (!forwarded && Date.now() < deadline) {
      forwarded = (await observedStateInFlight(runtime.baseUrl) || 0) >= 1;
      if (!forwarded) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(forwarded).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    process.kill(processIds[0]!, "SIGKILL");
    expect(await pending).toMatchObject({ status: 503, body: {
      jsonrpc: "2.0", id: "한글",
      error: { data: { code: "RUNTIME_RESPONSE_UNCONFIRMED", outcome: "unknown" } }
    } });
  }, 15_000);

  it("separates a proxy connection failure from still-fresh runtime readiness", async () => {
    const runtime = await start(undefined, undefined, {
      NODE_ENV: "test",
      CODEX_MCP_BRIDGE_TEST_CLOSE_HTTP_AFTER_READY_MS: "100"
    }, true);
    await new Promise(resolve => setTimeout(resolve, 250));

    const readiness = await fetch(`${runtime.baseUrl}/readyz`);
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      reason: "ready",
      limitations: []
    });

    const failed = await fetch(`${runtime.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({
      reason: "state-recovering",
      limitations: ["state-response-unconfirmed"],
      outcome: "not-observed",
      runtimeReadiness: {
        ready: true,
        reason: "ready",
        limitations: []
      }
    });
  });

  it("reports request capacity separately when only the added body crosses the limit", async () => {
    const runtime = await start();
    const sockets: Socket[] = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        sockets.push(await openIncompleteMcpRequest(
          runtime.baseUrl,
          7 * 1024 * 1024
        ));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      const before = await fetch(`${runtime.baseUrl}/readyz`);
      expect(before.status).toBe(200);
      await expect(before.json()).resolves.toMatchObject({
        reason: "ready",
        limitations: []
      });

      const rejected = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(6 * 1024 * 1024)
      });
      expect(rejected.status).toBe(503);
      await expect(rejected.json()).resolves.toMatchObject({
        reason: "state-capacity",
        limitations: ["state-capacity"],
        outcome: "not-observed",
        runtimeReadiness: {
          ready: true,
          reason: "ready",
          limitations: []
        }
      });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 15_000);

  it("reserves MCP byte capacity for exact recovery reads", async () => {
    const runtime = await start();
    const sockets: Socket[] = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        sockets.push(await openIncompleteMcpRequest(runtime.baseUrl, 8 * 1024 * 1024));
      }
      await waitUntilCapacity(runtime.baseUrl);
      const exact = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json", "content-type": "application/json",
          "mcp-protocol-version": CURRENT_PROTOCOL,
          "mcp-method": "tools/call", "mcp-name": "codex_status"
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "byte-reserved", method: "tools/call",
          params: { name: "codex_status", arguments: {
            scopeId: randomUUID(), query: { kind: "job", id: randomUUID() }
          }, _meta: {
            "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": { name: "runtime-process-regression", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {}
          } }
        })
      });
      expect(exact.status).toBe(200);
      await expect(exact.json()).resolves.toMatchObject({
        jsonrpc: "2.0", id: "byte-reserved", result: { isError: true }
      });
      const ordinary = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(ordinary.status).toBe(503);
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(3);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 15_000);

  it("applies the same bounded exact-read reservation to declared and chunked bodies", async () => {
    const runtime = await start();
    const sockets: Socket[] = [];
    const call = JSON.stringify({
      jsonrpc: "2.0", id: "chunked-exact", method: "tools/call",
      params: { name: "codex_status", arguments: {
        scopeId: randomUUID(), query: { kind: "job", id: randomUUID() }
      }, _meta: {
        "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "runtime-process-regression", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      } }
    });
    const headers = {
      accept: "application/json", "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL,
      "mcp-method": "tools/call", "mcp-name": "codex_status"
    };
    const exactResponses = async () => {
      const declared = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST", headers, body: call
      });
      expect(declared.status).toBe(200);
      await expect(declared.json()).resolves.toMatchObject({
        jsonrpc: "2.0", id: "chunked-exact", result: { isError: true }
      });
      const chunked = await postMcpChunks(runtime.baseUrl, [
        Buffer.from(call.slice(0, 40)), Buffer.from(call.slice(40))
      ], headers);
      expect(chunked).toMatchObject({
        status: 200, body: { jsonrpc: "2.0", id: "chunked-exact", result: { isError: true } }
      });
    };
    try {
      for (const headroom of [64, 0]) {
        for (let index = 0; index < 3; index += 1) {
          sockets.push(await openIncompleteMcpRequest(runtime.baseUrl,
            8 * 1024 * 1024 - (index === 2 ? headroom : 0)));
        }
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && await observedStateInFlight(runtime.baseUrl) !== 3) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(await observedStateInFlight(runtime.baseUrl)).toBe(3);
        await exactResponses();
        const ordinary = await postMcpChunks(runtime.baseUrl, [Buffer.from("{}")]);
        expect(ordinary.status === 503).toBe(headroom === 0);
        if (headroom === 64) {
          const largeOrdinary = await postMcpChunks(runtime.baseUrl, [Buffer.from(
            JSON.stringify({ jsonrpc: "2.0", params: { padding: "x".repeat(300_000) },
              method: "ping", id: "large-ordinary" })
          )]);
          expect(largeOrdinary).toMatchObject({
            status: 503, body: { jsonrpc: "2.0", id: "large-ordinary" }
          });
        }
        for (const socket of sockets.splice(0)) socket.destroy();
        await waitUntilReady(runtime.baseUrl);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 20_000);

  it("preserves a chunked exact read when another request fills ordinary bytes after its headers", async () => {
    const runtime = await start();
    const sockets: Socket[] = [];
    const call = JSON.stringify({
      jsonrpc: "2.0", id: "concurrent-chunked-exact", method: "tools/call",
      params: { name: "codex_status", arguments: {
        scopeId: randomUUID(), query: { kind: "job", id: randomUUID() }
      }, _meta: {
        "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "runtime-process-regression", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      } }
    });
    const headers = {
      accept: "application/json", "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL,
      "mcp-method": "tools/call", "mcp-name": "codex_status"
    };
    let delayedRequest: ReturnType<typeof httpRequest> | undefined;
    try {
      for (let index = 0; index < 3; index += 1) {
        sockets.push(await openIncompleteMcpRequest(runtime.baseUrl,
          8 * 1024 * 1024 - (index === 2 ? 512 * 1024 : 0)));
      }
      const beforeDeadline = Date.now() + 3_000;
      while (Date.now() < beforeDeadline && await observedStateInFlight(runtime.baseUrl) !== 3) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(3);

      const delayedResponse = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        delayedRequest = httpRequest(`${runtime.baseUrl}/mcp`, { method: "POST", headers }, response => {
          const received: Buffer[] = [];
          response.on("data", (chunk: Buffer) => received.push(chunk));
          response.once("error", reject);
          response.once("end", () => {
            try {
              resolve({ status: response.statusCode || 0,
                body: JSON.parse(Buffer.concat(received).toString("utf8")) as Record<string, unknown> });
            } catch (error) { reject(error); }
          });
        });
        delayedRequest.once("error", reject);
        delayedRequest.flushHeaders();
      });
      const headerDeadline = Date.now() + 3_000;
      while (Date.now() < headerDeadline && await observedStateInFlight(runtime.baseUrl) !== 4) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(4);

      sockets.push(await openIncompleteMcpRequest(runtime.baseUrl, 512 * 1024));
      const fullDeadline = Date.now() + 3_000;
      while (Date.now() < fullDeadline && await observedStateInFlight(runtime.baseUrl) !== 5) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(5);

      delayedRequest.end(call);
      expect(await delayedResponse).toMatchObject({
        status: 200,
        body: { jsonrpc: "2.0", id: "concurrent-chunked-exact", result: { isError: true } }
      });
      const declared = await fetch(`${runtime.baseUrl}/mcp`, { method: "POST", headers, body: call });
      expect(declared.status).toBe(200);
      await expect(declared.json()).resolves.toMatchObject({
        jsonrpc: "2.0", id: "concurrent-chunked-exact", result: { isError: true }
      });
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(4);
    } finally {
      delayedRequest?.destroy();
      for (const socket of sockets) socket.destroy();
    }
    await waitUntilReady(runtime.baseUrl);
    const ordinary = await postMcpChunks(runtime.baseUrl, [Buffer.from("{}")]);
    expect(ordinary.status).not.toBe(503);
  }, 20_000);

  it("keeps completion waits out of the control reserve while admitting delivery decisions", async () => {
    const runtime = await start();
    const sockets: Socket[] = [];
    const body = (operation: string, id: string) => JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "codex_ui_completion", arguments: {
        operation, jobId: randomUUID(), presentationRef: "0".repeat(64),
        widgetInstanceId: randomUUID(), receipt: "completion-" + "0".repeat(64)
      }, _meta: {
        "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "runtime-process-regression", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      } }
    });
    try {
      for (let index = 0; index < 112; index += 1) {
        sockets.push(await openIncompleteMcpRequest(runtime.baseUrl));
      }
      await waitUntilCapacity(runtime.baseUrl);
      const waits = await Promise.all(Array.from({ length: 16 }, (_, index) =>
        postMcpChunks(runtime.baseUrl, [Buffer.from(body("wait", `card-wait-${index}`))])
      ));
      expect(waits.every(result => result.status === 503 &&
        (result.body.error as { data?: { outcome?: string } })?.data?.outcome === "not-observed"))
        .toBe(true);
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(112);
      const decision = await postMcpChunks(runtime.baseUrl,
        [Buffer.from(body("accepted", "card-accepted"))], {
          accept: "application/json", "content-type": "application/json",
          "mcp-protocol-version": CURRENT_PROTOCOL,
          "mcp-method": "tools/call", "mcp-name": "codex_ui_completion"
        });
      expect(decision.status).toBe(200);
      expect(decision.body).toMatchObject({
        jsonrpc: "2.0", id: "card-accepted", result: { isError: true }
      });
      // Invalid fixture references reach the real handler and fail its scope
      // checks. They cannot turn into a successful host receipt.
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(112);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 20_000);

  it("finishes valid question, cancellation, result and host receipt controls during observer saturation", async () => {
    const runtime = await start(undefined, undefined, {
      CODEX_MCP_BRIDGE_CODEX: path.join(process.cwd(), "test/fixtures/fake-codex-app-server.mjs"),
      CODEX_MCP_BRIDGE_UPSTREAM_POOL_SIZE: "2",
      CODEX_TEST_RUNTIME_AUTH_FIXTURE: "1",
      CODEX_TEST_PROCESS_SCOPED_THREAD_IDS: "1"
    });
    const sockets: Socket[] = [];
    const client = new Client(
      { name: "runtime-priority-controls", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: CURRENT_PROTOCOL } } }
    );
    const until = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 12_000;
      while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error("Priority control fixture did not settle.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const jobRow = (db: Database.Database, jobId: string) => db.prepare(
      "SELECT status, job_version AS version FROM jobs WHERE job_id = ?"
    ).get(jobId) as { status: string; version: number } | undefined;
    const readJob = (jobId: string) => {
      const db = new Database(path.join(runtime.root, "state.sqlite"), { readonly: true });
      try { return jobRow(db, jobId); } finally { db.close(); }
    };
    try {
      await runtime.server.applicationService.updateSettings({
        expectedRegistryRevision: 0,
        operation: { kind: "patch", settings: {
          projectOperations: [{ kind: "add", project: {
            name: "Priority control fixture", cwd: runtime.root
          } }]
        } }
      });
      const db = new Database(path.join(runtime.root, "state.sqlite"), { readonly: true });
      const project = db.prepare(
        "SELECT name, project_ref AS projectRef, project_revision AS projectRevision " +
        "FROM projects WHERE archived_at IS NULL AND deleted_at IS NULL LIMIT 1"
      ).get() as { name: string; projectRef: string; projectRevision: number };
      db.close();
      await client.connect(new StreamableHTTPClientTransport(new URL(`${runtime.baseUrl}/mcp`)));
      const descriptor = (await client.listTools()).tools.find(tool => tool.name === "codex_task")!;
      const properties = descriptor.inputSchema.properties as Record<string, { const?: string }>;
      const task = async (prompt: string) => {
        const metadata = { "openai/session": randomUUID() };
        const result = await client.callTool({
          name: "codex_task", _meta: metadata,
          arguments: {
            requestId: randomUUID(),
            taskContractVersion: properties.taskContractVersion?.const,
            executionEnvelopeRef: properties.executionEnvelopeRef?.const,
            prompt, project,
            selection: { model: "gpt-5.6-sol", reasoningEffort: "max" }
          }
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return { ...(result.structuredContent as { jobId: string; nextActions: Array<{
          kind: string; tool?: string; arguments?: Record<string, unknown>
        }> }), metadata };
      };
      const finished = await task("complete priority fixture");
      await until(() => readJob(finished.jobId)?.status === "completed");
      const question = await task("blocking input");
      const cancelling = await task("hold priority fixture");
      let questionRef: string | undefined;
      await until(async () => {
        const input = await client.callTool({
          name: "codex_status", _meta: question.metadata,
          arguments: { query: { kind: "input", jobId: question.jobId } }
        });
        expect(input.isError, JSON.stringify(input)).not.toBe(true);
        questionRef = (input.structuredContent as any).questions?.[0]?.questionRef;
        return Boolean(questionRef);
      });
      const render = finished.nextActions.find(action =>
        action.kind === "tool" && action.tool === "codex_dashboard")!;
      expect(render).toBeDefined();
      const opened = await client.callTool({
        name: "codex_dashboard", arguments: render.arguments!, _meta: finished.metadata
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const widgetInstanceId = randomUUID();
      const claimed = await client.callTool({
        name: "codex_ui_completion", _meta: finished.metadata,
        arguments: { operation: "wait", jobId: finished.jobId,
          presentationRef: render.arguments!.presentationRef, widgetInstanceId }
      });
      expect(claimed.isError, JSON.stringify(claimed)).not.toBe(true);
      const receipt = (claimed.structuredContent as any).receipt as string;
      expect(receipt).toMatch(/^completion-/);

      for (let index = 0; index < 112; index += 1) {
        sockets.push(await openIncompleteMcpRequest(runtime.baseUrl));
      }
      await waitUntilCapacity(runtime.baseUrl);
      const answer = await client.callTool({
        name: "codex_answer", _meta: question.metadata,
        arguments: { requestId: randomUUID(), jobId: question.jobId,
          questionRef: questionRef!, answers: { color: ["blue"] } }
      });
      expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
      expect(answer.structuredContent, JSON.stringify(answer.structuredContent))
        .toMatchObject({ delivery: "delivered" });
      const cancelVersion = readJob(cancelling.jobId)!.version;
      const cancelled = await client.callTool({
        name: "codex_cancel", _meta: cancelling.metadata,
        arguments: { requestId: randomUUID(),
          target: { kind: "job", id: cancelling.jobId },
          expectedVersion: cancelVersion, reason: "Priority control fixture" }
      });
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true);
      const accepted = await client.callTool({
        name: "codex_ui_completion", _meta: finished.metadata,
        arguments: { operation: "accepted", jobId: finished.jobId,
          presentationRef: render.arguments!.presentationRef,
          widgetInstanceId, receipt }
      });
      expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
      expect(accepted.structuredContent).toMatchObject({ deliveryState: "host-accepted" });
      const exact = await client.callTool({
        name: "codex_status", _meta: finished.metadata,
        arguments: { query: { kind: "job", id: finished.jobId } }
      });
      expect(exact.isError, JSON.stringify(exact)).not.toBe(true);
      expect(exact.structuredContent).toMatchObject({
        items: [expect.objectContaining({ id: finished.jobId, state: "completed",
          completionEvidence: expect.objectContaining({
            deliveryRecord: "host-accepted", jobRecord: "terminal-committed"
          }) })]
      });
      await until(() => readJob(question.jobId)?.status === "completed");
      expect(readJob(cancelling.jobId)?.status).toBe("cancelled");
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(112);
      for (const socket of sockets.splice(0)) socket.destroy();
      await until(async () => await observedStateInFlight(runtime.baseUrl) === 0);
      await waitUntilReady(runtime.baseUrl);
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await client.close().catch(() => {});
    }
  }, 35_000);

  it("reserves native control capacity when incomplete MCP requests saturate the proxy", async () => {
    const runtime = await start();
    const sockets: Socket[] = [];
    try {
      const oversized = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(8 * 1024 * 1024 + 1)
      });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toMatchObject({
        code: "RUNTIME_REQUEST_TOO_LARGE",
        reason: "request-bytes"
      });

      for (let index = 0; index < 112; index += 1) {
        sockets.push(await openIncompleteMcpRequest(runtime.baseUrl));
      }
      const capacity = await waitUntilCapacity(runtime.baseUrl);
      await expect(capacity.json()).resolves.toMatchObject({
        ok: false,
        reason: "state-capacity"
      });

      await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
        settings: { settingsRevision: expect.any(Number) }
      });
      const rejected = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(rejected.status).toBe(503);
      await expect(rejected.json()).resolves.toMatchObject({
        code: "RUNTIME_RESPONSE_UNCONFIRMED",
        reason: "state-capacity",
        limitations: ["state-capacity"],
        retryable: true,
        outcome: "not-observed"
      });

      const identified = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json", "content-type": "application/json",
          "mcp-protocol-version": CURRENT_PROTOCOL,
          "mcp-method": "tools/call", "mcp-name": "codex_status"
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "capacity-identified", method: "tools/call",
          params: { name: "codex_status", arguments: {
            scopeId: randomUUID(), query: { kind: "job", id: randomUUID() }
          }, _meta: {
            "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": { name: "runtime-process-regression", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {}
          } }
        })
      });
      const identifiedBody = await identified.json() as { result?: { isError?: boolean }; error?: unknown };
      expect({ status: identified.status, body: identifiedBody }).toMatchObject({ status: 200 });
      expect(identifiedBody.error).toBeUndefined();
      expect(identifiedBody.result?.isError).toBe(true);

      for (const name of ["codex_answer", "codex_cancel", "codex_steer"] as const) {
        const control = await fetch(`${runtime.baseUrl}/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json", "content-type": "application/json",
            "mcp-protocol-version": CURRENT_PROTOCOL,
            "mcp-method": "tools/call", "mcp-name": name
          },
          body: JSON.stringify({
            jsonrpc: "2.0", id: name, method: "tools/call",
            params: { name, arguments: {}, _meta: {
              "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
              "io.modelcontextprotocol/clientInfo": { name: "runtime-process-regression", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {}
            } }
          })
        });
        expect(control.status).not.toBe(503);
        await expect(control.json()).resolves.toMatchObject({ jsonrpc: "2.0", id: name });
      }

      const broadStatus = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "broad-status", method: "tools/call",
          params: { name: "codex_status", arguments: {} } })
      });
      expect(broadStatus.status).toBe(503);
      await expect(broadStatus.json()).resolves.toMatchObject({
        jsonrpc: "2.0", id: "broad-status", error: {
          data: { reason: "state-capacity", outcome: "not-observed" }
        }
      });
      const longWait = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "long-wait", method: "tools/call",
          params: { name: "codex_status", arguments: {
            scopeId: randomUUID(), query: {
              kind: "job", id: randomUUID(), waitFor: "terminal", waitMs: 20_000
            }
          } } })
      });
      expect(longWait.status).toBe(503);

      const mismatched = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json", "content-type": "application/json",
          "mcp-protocol-version": CURRENT_PROTOCOL,
          "mcp-method": "tools/call", "mcp-name": "codex_models"
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "priority-mismatch", method: "tools/call",
          params: { name: "codex_status", arguments: {
            scopeId: randomUUID(), query: { kind: "job", id: randomUUID() }
          }, _meta: {
            "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
            "io.modelcontextprotocol/clientInfo": { name: "runtime-process-regression", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {}
          } }
        })
      });
      expect(mismatched.status).toBe(400);
      await expect(mismatched.json()).resolves.toMatchObject({
        jsonrpc: "2.0", id: "priority-mismatch", error: { code: -32020 }
      });

      const numeric = await postMcpChunks(runtime.baseUrl, [
        Buffer.from('{"jsonrpc":"2.0","id":12'),
        Buffer.from('34,"method":"ping"}')
      ]);
      expect(numeric).toMatchObject({ status: 503, body: {
        jsonrpc: "2.0", id: 1234,
        error: { data: { reason: "state-capacity", outcome: "not-observed" } }
      } });

      const exponent = await postMcpChunks(runtime.baseUrl, [
        Buffer.from('{"jsonrpc":"2.0","id":1e3,"method":"ping"}')
      ]);
      expect(exponent).toMatchObject({ status: 503, body: {
        jsonrpc: "2.0", id: 1000
      } });

      const unicode = Buffer.from('{"jsonrpc":"2.0","id":"한글","method":"ping"}');
      const splitAt = Buffer.byteLength('{"jsonrpc":"2.0","id":"') + 1;
      const splitUnicode = await postMcpChunks(runtime.baseUrl, [
        unicode.subarray(0, splitAt), unicode.subarray(splitAt)
      ]);
      expect(splitUnicode).toMatchObject({ status: 503, body: {
        jsonrpc: "2.0", id: "한글"
      } });

      const afterLargeParams = await postMcpChunks(runtime.baseUrl, [
        Buffer.from(JSON.stringify({ jsonrpc: "2.0", params: {
          id: "nested-is-not-the-request-id", padding: "x".repeat(70 * 1024)
        }, id: "after-large-params", method: "ping" }))
      ]);
      expect(afterLargeParams).toMatchObject({ status: 503, body: {
        jsonrpc: "2.0", id: "after-large-params"
      } });

      const incomplete = await postMcpChunks(runtime.baseUrl, [
        Buffer.from('{"jsonrpc":"2.0","id":12')
      ]);
      expect(incomplete).toMatchObject({ status: 503, body: {
        code: "RUNTIME_RESPONSE_UNCONFIRMED", reason: "state-capacity"
      } });
      expect(incomplete.body).not.toHaveProperty("id");
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  }, 20_000);

  it("bounds MCP control reservations and releases disconnected observers", async () => {
    const processIds: number[] = [];
    const runtime = await start(processId => processIds.push(processId));
    const sockets: Socket[] = [];
    const controllers: AbortController[] = [];
    const requests: Promise<unknown>[] = [];
    let stopped = false;
    try {
      for (let index = 0; index < 112; index += 1) {
        sockets.push(await openIncompleteMcpRequest(runtime.baseUrl));
      }
      await waitUntilCapacity(runtime.baseUrl);
      process.kill(processIds[0]!, "SIGSTOP");
      stopped = true;
      for (let index = 0; index < 16; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        requests.push(fetch(`${runtime.baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: `priority-${index}`, method: "tools/call",
            params: { name: "codex_status", arguments: {
              scopeId: randomUUID(), query: { kind: "job", id: randomUUID() }
            } }
          }),
          signal: controller.signal
        }).catch(error => error));
      }
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && await observedStateInFlight(runtime.baseUrl) !== 128) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(128);
      const overflow = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "priority-overflow", method: "tools/call",
          params: { name: "codex_status", arguments: {
            scopeId: randomUUID(), query: { kind: "job", id: randomUUID() }
          } } })
      });
      expect(overflow.status).toBe(503);
      controllers.forEach(controller => controller.abort());
      await Promise.all(requests);
      const releaseDeadline = Date.now() + 3_000;
      while (Date.now() < releaseDeadline &&
        await observedStateInFlight(runtime.baseUrl) !== 112) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(112);
    } finally {
      controllers.forEach(controller => controller.abort());
      if (stopped) process.kill(processIds[0]!, "SIGCONT");
      for (const socket of sockets) socket.destroy();
    }
  }, 15_000);

  it("releases the HTTP observer when a complete caller disconnects", async () => {
    const runtime = await start(undefined, undefined, {
      NODE_ENV: "test",
      CODEX_MCP_BRIDGE_TEST_CONFORMANCE_DELAY_MS: "5000"
    }, true);
    const controller = new AbortController();
    const pending = conformanceToolCall(runtime.baseUrl, controller.signal);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if ((await observedStateInFlight(runtime.baseUrl) || 0) === 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await observedStateInFlight(runtime.baseUrl)).toBe(1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    const releaseDeadline = Date.now() + 2_000;
    while (Date.now() < releaseDeadline &&
      (await observedStateInFlight(runtime.baseUrl) || 0) !== 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await observedStateInFlight(runtime.baseUrl)).toBe(0);
  }, 12_000);

  it("keeps timed-out native requests reserved until their physical responses arrive", async () => {
    const processIds: number[] = [];
    const runtime = await start(processId => processIds.push(processId), undefined, {
      NODE_ENV: "test",
      CODEX_MCP_BRIDGE_TEST_RPC_OBSERVATION_TIMEOUT_MS: "250"
    });
    expect(processIds).toHaveLength(1);
    process.kill(processIds[0]!, "SIGSTOP");
    try {
      const first = Array.from({ length: 120 }, () =>
        runtime.server.applicationService.settingsSnapshot().catch(error => error)
      );
      const settled = await Promise.all(first);
      expect(settled.every(value => value instanceof Error &&
        value.message.includes("RUNTIME_RESPONSE_UNCONFIRMED"))).toBe(true);
      await expect(runtime.server.applicationService.settingsSnapshot())
        .rejects.toThrow(/RUNTIME_CAPACITY/);
      const controls = await Promise.all(Array.from({ length: 8 }, () =>
        runtime.server.applicationService.markNativeCompletionNotificationsDelivered({
          outboxIds: [], leaseOwner: randomUUID()
        }).catch(error => error)
      ));
      expect(controls.every(value => value instanceof Error &&
        value.message.includes("RUNTIME_RESPONSE_UNCONFIRMED"))).toBe(true);
      expect(await observedStateInFlight(runtime.baseUrl)).toBe(128);
      await expect(runtime.server.applicationService.markNativeCompletionNotificationsDelivered({
        outboxIds: [], leaseOwner: randomUUID()
      })).rejects.toThrow(/RUNTIME_CAPACITY/);
    } finally {
      process.kill(processIds[0]!, "SIGCONT");
    }
    const releaseDeadline = Date.now() + 8_000;
    while (Date.now() < releaseDeadline &&
      (await observedStateInFlight(runtime.baseUrl) || 0) !== 0) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(await observedStateInFlight(runtime.baseUrl)).toBe(0);
  }, 15_000);

  it("keeps public liveness responsive while bounded large MCP payloads are parsed", async () => {
    const runtime = await start();
    const padding = "x".repeat(6 * 1024 * 1024);
    const requests = Array.from({ length: 4 }, (_, index) => fetch(`${runtime.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: index + 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: `large-payload-${index}`, version: "1" },
          padding
        }
      })
    }));
    const samples = await Promise.all(Array.from({ length: 30 }, async () => {
      const startedAt = performance.now();
      const response = await fetch(`${runtime.baseUrl}/healthz`);
      return { status: response.status, durationMs: performance.now() - startedAt };
    }));
    const settled = await Promise.allSettled(requests);

    expect(settled.every(result => result.status === "fulfilled")).toBe(true);
    expect(samples.every(sample => sample.status === 200)).toBe(true);
    expect(Math.max(...samples.map(sample => sample.durationMs))).toBeLessThan(750);
  }, 30_000);

  it("recovers a killed runtime without claiming an in-flight write committed", async () => {
    const processIds: number[] = [];
    const runtime = await start(processId => processIds.push(processId));
    const current = await runtime.server.applicationService.settingsSnapshot();
    const locker = new Database(path.join(runtime.root, "state.sqlite"));
    locker.exec("BEGIN IMMEDIATE");
    try {
      const mutation = runtime.server.applicationService.updateSettings({
        expectedSettingsRevision: current.settings.settingsRevision,
        operation: {
          kind: "patch",
          settings: {
            showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
          }
        }
      }).then(
        () => ({ ok: true as const, error: "" }),
        error => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error)
        })
      );
      const deadline = Date.now() + 3_000;
      while (
        runtime.server.applicationService.runtimeHealth?.().stateService?.activeOperation?.phase !==
          "write-lock-wait" &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(runtime.server.applicationService.runtimeHealth?.()).toMatchObject({
        stateService: { activeOperation: { phase: "write-lock-wait" } }
      });
      expect(processIds).toHaveLength(1);
      process.kill(processIds[0]!, "SIGKILL");
      expect(await mutation).toMatchObject({
        ok: false,
        error: expect.stringMatching(/RUNTIME_(?:OUTCOME_UNKNOWN|RESPONSE_UNCONFIRMED)/)
      });
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }

    await waitUntilReady(runtime.baseUrl, 12_000);
    expect(processIds.length).toBeGreaterThanOrEqual(2);
    await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: { settingsRevision: current.settings.settingsRevision }
    });
    await expect(runtime.server.applicationService.updateSettings({
      expectedSettingsRevision: current.settings.settingsRevision,
      operation: {
        kind: "patch",
        settings: {
          showBridgeThreadsInCodexApp: !current.settings.showBridgeThreadsInCodexApp
        }
      }
    })).resolves.toMatchObject({
      settings: { settingsRevision: current.settings.settingsRevision + 1 }
    });
  }, 25_000);

  it("continues recovery when a replacement runtime misses its startup deadline", async () => {
    const processIds: number[] = [];
    const runtime = await start(processId => {
      processIds.push(processId);
      if (processIds.length === 2) process.kill(processId, "SIGSTOP");
    }, 2_500);

    expect(processIds).toHaveLength(1);
    process.kill(processIds[0]!, "SIGKILL");
    const replacementDeadline = Date.now() + 8_000;
    while (processIds.length < 3 && Date.now() < replacementDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(processIds.length).toBeGreaterThanOrEqual(3);
    await waitUntilReady(runtime.baseUrl, 8_000);

    await expect(runtime.server.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: { settingsRevision: expect.any(Number) }
    });
  }, 12_000);

  it("keeps the operational database rollback-compatible and rebuilds telemetry independently", async () => {
    const runtime = await start();
    const environment = runtimeEnvironment(runtime.root);
    const config = loadConfig(environment);
    const initial = await runtime.server.applicationService.settingsSnapshot();
    await expect(runtime.server.applicationService.updateSettings({
      expectedSettingsRevision: initial.settings.settingsRevision,
      operation: {
        kind: "patch",
        settings: { uiLocalePreference: "ko" }
      }
    })).resolves.toMatchObject({
      settings: { settingsRevision: initial.settings.settingsRevision + 1 }
    });
    await new Promise<void>(resolve => runtime.server.close(() => resolve()));

    const rollbackStore = new BridgeStateStore({ file: config.stateDatabaseFile });
    try {
      const rollbackSettings = new UserSettingsStore(config, { stateStore: rollbackStore });
      expect(rollbackSettings.current).toMatchObject({
        settingsRevision: initial.settings.settingsRevision + 1,
        uiLocalePreference: "ko"
      });
    } finally {
      rollbackStore.close();
    }

    await Promise.all([
      rm(config.telemetryDatabaseFile, { force: true }),
      rm(`${config.telemetryDatabaseFile}-wal`, { force: true }),
      rm(`${config.telemetryDatabaseFile}-shm`, { force: true })
    ]);
    const restarted = await createIsolatedHttpServer(config, {
      childEnvironment: environment
    });
    await new Promise<void>((resolve, reject) => {
      restarted.once("error", reject);
      restarted.listen(0, "127.0.0.1", () => {
        restarted.removeListener("error", reject);
        resolve();
      });
    });
    const address = restarted.address();
    if (!address || typeof address === "string") throw new Error("Missing restart address.");
    runtime.server = restarted;
    runtime.baseUrl = `http://127.0.0.1:${address.port}`;
    await waitUntilReady(`http://127.0.0.1:${address.port}`);
    await expect(restarted.applicationService.settingsSnapshot()).resolves.toMatchObject({
      settings: {
        settingsRevision: initial.settings.settingsRevision + 1,
        uiLocalePreference: "ko"
      }
    });
    expect(restarted.applicationService.runtimeHealth?.()).toMatchObject({
      telemetryService: { status: "ready" }
    });
  }, 25_000);
});
