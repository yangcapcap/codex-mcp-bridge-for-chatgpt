import {
  chmodSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MACOS_HELPER_PROTOCOL_NAME,
  MACOS_HELPER_PROTOCOL_VERSION,
  MacOSBridgeSupervisor,
  startMacOSHelperServer,
  type MacOSHelperController,
  type MacOSHelperStatus
} from "../src/macosHelperServer.js";
import { startPrivateJsonLineServer, type BridgeCompanionServer } from "../src/companionServer.js";
import { CodexRuntimeManager } from "../src/codexRuntime.js";
import { CodexAuthSelectionManager } from "../src/codexAuthSelection.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { writeManagedRuntimeStatus } from "../scripts/runtime-status.mjs";
import { updateRuntimeEnvFile } from "../scripts/runtime-env.mjs";
import { acquireRuntimeLock } from "../scripts/runtime-lock.mjs";
import {
  createSchema18Fixture,
  createSeededSchema3Fixture
} from "./helpers/stateSchemaFixtures.js";

import { writeFakeLauncher } from "./fixtures/macosHelperLauncher.js";
import { syntheticIdToken } from "./fixtures/syntheticAuth.js";

const servers: BridgeCompanionServer[] = [];

describe("central runtime lifecycle reservations", () => {
  it("remembers distinct explicit Codex homes already used by the Helper without a folder picker", async () => {
    const f = await lifecycleFixture();
    const first = path.join(f.root, "existing-a");
    const second = path.join(f.root, "existing-b");
    mkdirSync(first); mkdirSync(second);
    const base = readFileSync(f.envFile, "utf8") + `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\n`;
    try {
      writeFileSync(f.envFile, base + `CODEX_HOME=${first}\n`, { mode: 0o600 });
      const firstStatus = await f.supervisor.codexRuntime({ action: "status", includeAccount: false });
      expect(firstStatus.authSelection?.knownHomes?.map(item => item.home)).toEqual([first]);
      await f.supervisor.start();
      writeFileSync(f.envFile, base + `CODEX_HOME=${second}\n`, { mode: 0o600 });
      const pendingStatus = await f.supervisor.codexRuntime({ action: "status", includeAccount: false });
      expect(pendingStatus.environmentPending).toBe(true);
      expect(pendingStatus.authSelection?.knownHomes?.map(item => item.home)).toEqual([first]);
      await f.supervisor.stop({ mode: "force", timeoutMs: 5_000 });
      const secondStatus = await f.supervisor.codexRuntime({ action: "status", includeAccount: false });
      expect(secondStatus.authSelection?.knownHomes?.map(item => item.home)).toEqual([first, second]);
      writeFileSync(f.envFile, base, { mode: 0o600 });
      const selectable = await f.supervisor.codexRuntime({ action: "status", includeAccount: false });
      expect(selectable.authSelection).toMatchObject({ overrideActive: false,
        knownHomes: [{ home: first }, { home: second }] });
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it("offers an existing bridge-owned profile as a selectable candidate without starting login", async () => {
    const f = await lifecycleFixture();
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\n`, { mode: 0o600 });
    const auth = new CodexAuthSelectionManager(f.manager.root);
    try {
      const prepared = await auth.prepare("bridge-chatgpt", 0, {});
      const profileId = prepared.candidate!.id;
      await auth.cancelCandidate(profileId, prepared.revision);
      await f.supervisor.codexRuntime({ action: "auth-select-profile",
        authProfileId: profileId, authRevision: 2 });
      expect(await auth.snapshot({})).toMatchObject({
        candidate: { id: profileId, reused: true, status: "prepared" }, profiles: [{ id: profileId }]
      });
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it("keeps a pending auth change inert on ordinary start and applies it only through a drained restart", async () => {
    const f = await lifecycleFixture();
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\nCODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${path.join(f.root, "state.sqlite")}\n`,
      { mode: 0o600 });
    const auth = new CodexAuthSelectionManager(f.manager.root);
    await auth.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", {}, false);
    f.update({ activeJobs: 0 });
    try {
      const first = await f.supervisor.start();
      expect(await auth.snapshot({})).toMatchObject({ applied: { kind: "shared" }, pending: { kind: "disconnected" } });
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(["completed", "failed"]).toContain(f.supervisor.lifecycleStatus()?.phase), {
        timeout: 6_000, interval: 50
      });
      if (f.supervisor.lifecycleStatus()?.phase === "failed") throw new Error(f.supervisor.lifecycleStatus()?.error || "unknown lifecycle error");
      expect((await f.supervisor.health()).pid).not.toBe(first.pid);
      expect(await auth.snapshot({})).toMatchObject({ applied: { kind: "disconnected" }, pending: null, generation: 1 });
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it("keeps the prior choice pending when a launched authentication runtime never becomes ready", async () => {
    const f = await lifecycleFixture();
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\nCODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${path.join(f.root, "state.sqlite")}\n`,
      { mode: 0o600 });
    const auth = new CodexAuthSelectionManager(f.manager.root);
    await auth.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", {}, false);
    f.update({ activeJobs: 0 });
    try {
      await f.supervisor.start();
      writeFakeLauncher(path.join(f.root, "runtime", "launcher.mjs"), path.join(f.root, "failed-arguments.json"),
        { admissionFile: path.join(f.root, "admission.json"), writeRuntimeLock: true, failAuthenticationActivation: true });
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("failed"), {
        timeout: 8_000, interval: 50
      });
      expect(f.supervisor.lifecycleStatus()?.error).toContain("CODEX_AUTH_ACTIVATION_UNCERTAIN");
      expect(await auth.snapshot({})).toMatchObject({
        applied: { kind: "shared" }, pending: { kind: "disconnected" }, activation: { status: "uncertain" }
      });
      const uncertain = await auth.snapshot({});
      await expect(f.supervisor.codexRuntime({ action: "auth-reconcile-stopped",
        authActivationId: uncertain.activation!.id, authRevision: uncertain.revision }))
        .rejects.toThrow("CODEX_AUTH_RECONCILIATION_CONFIRMATION_REQUIRED");
      await f.supervisor.codexRuntime({ action: "auth-reconcile-stopped",
        authActivationId: uncertain.activation!.id, authRevision: uncertain.revision,
        authResolutionConfirmed: true });
      expect(await auth.snapshot({})).toMatchObject({
        applied: { kind: "shared" }, pending: { kind: "disconnected" }, activation: null,
        lastActivationResolution: { id: uncertain.activation!.id, outcome: "stopped-unconfirmed" }
      });
      const restarted = await f.supervisor.start();
      expect(restarted.phase).toBe("running");
      expect((await auth.snapshot({})).pending?.kind).toBe("disconnected");
      writeFakeLauncher(path.join(f.root, "runtime", "launcher.mjs"), path.join(f.root, "recovered-arguments.json"),
        { admissionFile: path.join(f.root, "admission.json"), writeRuntimeLock: true });
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(["completed", "failed"]).toContain(f.supervisor.lifecycleStatus()?.phase), {
        timeout: 8_000, interval: 50
      });
      if (f.supervisor.lifecycleStatus()?.phase === "failed") {
        throw new Error(f.supervisor.lifecycleStatus()?.error || "activation retry failed");
      }
      expect(await auth.snapshot({})).toMatchObject({
        applied: { kind: "disconnected" }, pending: null, activation: null, generation: 1,
        lastActivationResolution: { id: uncertain.activation!.id, outcome: "stopped-unconfirmed" }
      });
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  }, 15_000);

  it("recovers profile A after profile B fails to launch and applies the same verified B candidate on retry", async () => {
    const command = path.resolve("test/fixtures/fake-codex-app-server.mjs");
    const f = await lifecycleFixture(false, command);
    vi.stubEnv("HOME", f.root);
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\nCODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${path.join(f.root, "state.sqlite")}\n`,
      { mode: 0o600 });
    const auth = new CodexAuthSelectionManager(f.manager.root);
    const environment = { HOME: f.root, PATH: process.env.PATH,
      CODEX_MCP_BRIDGE_RUNTIME_HOME: f.manager.root };
    const cliFingerprint = f.manager.appliedContextFingerprint();
    const prepare = async (account: string) => {
      const before = await auth.snapshot(environment);
      const candidate = (await auth.prepare("bridge-chatgpt", before.revision, environment)).candidate!;
      writeFileSync(path.join(f.manager.root, "auth-profiles", candidate.id, "auth.json"),
        JSON.stringify({ auth_mode: "chatgpt", tokens: {
          account_id: account, id_token: syntheticIdToken(`user-${account}`, account)
        } }), { mode: 0o600 });
      const verified = await auth.verify(candidate.id, command, cliFingerprint, environment);
      expect(verified.candidate).toMatchObject({ id: candidate.id, status: "verified" });
      expect(verified.candidate?.accountKey).toMatch(/^[a-f0-9]{64}$/);
      const staged = await auth.stage(candidate.connection, verified.revision,
        command, cliFingerprint, environment, false);
      expect(staged.pending).toEqual(candidate.connection);
      return { kind: "bridge-chatgpt" as const, profileId: candidate.id };
    };
    const restart = async () => {
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(["completed", "failed"]).toContain(f.supervisor.lifecycleStatus()?.phase), {
        timeout: 8_000, interval: 50
      });
      return f.supervisor.lifecycleStatus();
    };
    f.update({ activeJobs: 0 });
    try {
      const profileA = await prepare("workspace-a");
      await f.supervisor.start();
      const firstApply = await restart();
      if (firstApply?.phase === "failed") throw new Error(firstApply.error || "profile A activation failed");
      expect(await auth.snapshot(environment)).toMatchObject({
        applied: profileA, pending: null, activation: null, generation: 1
      });
      expect((await f.supervisor.codexRuntime({ action: "status", includeAccount: false }))
        .runningEnvironment?.codexHome).toBe(path.join(f.manager.root, "auth-profiles", profileA.profileId));
      const profileB = await prepare("workspace-b");
      writeFakeLauncher(path.join(f.root, "runtime", "launcher.mjs"), path.join(f.root, "failed-arguments.json"),
        { admissionFile: path.join(f.root, "admission.json"), writeRuntimeLock: true, failAuthenticationActivation: true });
      const failedApply = await restart();
      expect(failedApply?.phase).toBe("failed");
      expect(failedApply?.error).toContain("CODEX_AUTH_ACTIVATION_UNCERTAIN");
      const uncertain = await auth.snapshot(environment);
      expect(uncertain).toMatchObject({
        applied: profileA, pending: profileB, candidate: { id: profileB.profileId, status: "verified" },
        activation: { from: profileA, to: profileB, status: "uncertain" }, generation: 1
      });
      await expect(f.supervisor.start()).rejects.toThrow("CODEX_AUTH_ACTIVATION_UNCERTAIN");
      await f.supervisor.codexRuntime({ action: "auth-reconcile-stopped",
        authActivationId: uncertain.activation!.id, authRevision: uncertain.revision,
        authResolutionConfirmed: true });
      const recovered = await f.supervisor.start();
      expect(recovered.phase).toBe("running");
      expect(await auth.snapshot(environment)).toMatchObject({
        applied: profileA, pending: profileB, candidate: { id: profileB.profileId, status: "verified" },
        activation: null, generation: 1
      });
      expect((await f.supervisor.codexRuntime({ action: "status", includeAccount: false }))
        .runningEnvironment?.codexHome).toBe(path.join(f.manager.root, "auth-profiles", profileA.profileId));
      writeFakeLauncher(path.join(f.root, "runtime", "launcher.mjs"), path.join(f.root, "recovered-arguments.json"),
        { admissionFile: path.join(f.root, "admission.json"), writeRuntimeLock: true });
      const retriedApply = await restart();
      if (retriedApply?.phase === "failed") throw new Error(retriedApply.error || "profile B retry failed");
      expect(await auth.snapshot(environment)).toMatchObject({
        applied: profileB, pending: null, candidate: null, activation: null, generation: 2,
        lastActivationResolution: { id: uncertain.activation!.id, outcome: "stopped-unconfirmed" }
      });
      expect((await f.supervisor.codexRuntime({ action: "status", includeAccount: false }))
        .runningEnvironment?.codexHome).toBe(path.join(f.manager.root, "auth-profiles", profileB.profileId));
    } finally {
      try { await f.supervisor.close({ runtime: "force-stop" }); }
      finally { vi.unstubAllEnvs(); }
    }
  }, 30_000);

  it("does not resolve an unconfirmed activation while its runtime still runs", async () => {
    const f = await lifecycleFixture();
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\n`, { mode: 0o600 });
    const auth = new CodexAuthSelectionManager(f.manager.root);
    try {
      await f.supervisor.start();
      await auth.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", {}, false);
      const activationId = await auth.beginActivation("", "", {});
      await auth.failActivation(activationId!, false);
      const uncertain = await auth.snapshot({});
      await expect(f.supervisor.codexRuntime({ action: "auth-reconcile-stopped",
        authActivationId: activationId!, authRevision: uncertain.revision,
        authResolutionConfirmed: true })).rejects.toThrow("CODEX_AUTH_RUNTIME_STILL_RUNNING");
      expect((await auth.snapshot({})).activation?.id).toBe(activationId);
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it("keeps the original runtime when a persisted job still belongs to the old authentication", async () => {
    const f = await lifecycleFixture();
    const stateFile = path.join(f.root, "state.sqlite");
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\nCODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${stateFile}\n`,
      { mode: 0o600 });
    const auth = new CodexAuthSelectionManager(f.manager.root);
    await auth.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", {}, false);
    const store = new BridgeStateStore({ file: stateFile });
    store.upsertJob({ jobId: randomUUID(), scopeId: randomUUID(), requestId: randomUUID(),
      status: "running", updatedAt: 2 } as any);
    store.close();
    f.update({ activeJobs: 0 });
    try {
      const first = await f.supervisor.start();
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(["blocked", "failed"]).toContain(f.supervisor.lifecycleStatus()?.phase), {
        timeout: 6_000, interval: 50
      });
      expect((await f.supervisor.health()).pid).toBe(first.pid);
      expect(await auth.snapshot({})).toMatchObject({ applied: { kind: "shared" }, pending: { kind: "disconnected" } });
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it.each(["user-hold", "host-accepted", "acceptance-unknown"] as const)(
    "applies authentication while retaining a completed result protected by %s", async protection => {
    const f = await lifecycleFixture();
    const stateFile = path.join(f.root, "state.sqlite");
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${f.manager.root}\nCODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${stateFile}\n`,
      { mode: 0o600 });
    const auth = new CodexAuthSelectionManager(f.manager.root);
    await auth.stage({ kind: "disconnected" }, 0, "/fixture/codex", "fixture-cli", {}, false);
    const store = new BridgeStateStore({ file: stateFile });
    const jobId = randomUUID();
    const scopeId = randomUUID();
    const owner = "a".repeat(64);
    const result = { content: [{ type: "text", text: "Retained original result." }] };
    store.upsertJob({ jobId, scopeId, requestId: randomUUID(), authBoundary: owner,
      result, status: "completed", updatedAt: Date.now() } as any);
    if (protection === "user-hold") {
      store.holdResult(jobId, "Keep the original result", Date.now() + 60_000);
    } else {
      const leaseOwner = randomUUID();
      const leased = store.claimJobCompletionDelivery(jobId, scopeId, leaseOwner)!;
      const input = { jobId, scopeId, leaseOwner, receipt: leased.receipt };
      if (protection === "host-accepted") store.markJobCompletionHostAccepted(input);
      else store.markJobCompletionAcceptanceUnknown(input);
    }
    const delivery = store.getJobCompletionDelivery(jobId, scopeId);
    const reason = protection === "user-hold" ? "user-hold" : "undelivered-chatgpt-result";
    expect(store.retentionProtection(jobId)).toContain(reason);
    store.close();
    f.update({ activeJobs: 0 });
    try {
      const first = await f.supervisor.start();
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(["completed", "failed"]).toContain(f.supervisor.lifecycleStatus()?.phase), {
        timeout: 6_000, interval: 50
      });
      if (f.supervisor.lifecycleStatus()?.phase === "failed") {
        throw new Error(f.supervisor.lifecycleStatus()?.error || "result retention blocked activation");
      }
      expect((await f.supervisor.health()).pid).not.toBe(first.pid);
      expect(await auth.snapshot({})).toMatchObject({ applied: { kind: "disconnected" }, pending: null });
      const retained = new BridgeStateStore({ file: stateFile, readOnly: true });
      try {
        expect(retained.listJobs()).toContainEqual(expect.objectContaining({
          jobId, scopeId, authBoundary: owner, status: "completed", result
        }));
        expect(retained.getJobCompletionDelivery(jobId, scopeId)).toEqual(delivery);
        expect(retained.retentionProtection(jobId)).toContain(reason);
      } finally { retained.close(); }
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it("keeps a running job and its restart reservation for over 60 seconds, then restarts on its event", async () => {
    const f = await lifecycleFixture();
    try {
      const original = await f.supervisor.start();
      const receipt = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await new Promise(resolve => setTimeout(resolve, 61_000));
      const waiting = await f.supervisor.health();
      expect(waiting).toMatchObject({ phase: "running", pid: original.pid, bridge: { connected: true }, lifecycle: { requestId: receipt.requestId, phase: "waiting" } });
      f.update({ activeJobs: 0 });
      await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("completed"), { timeout: 6000, interval: 50 });
      const completed = await f.supervisor.health();
      expect(completed.pid).not.toBe(original.pid);
      expect(completed).toMatchObject({ phase: "running", bridge: { connected: true }, tunnel: { connected: true } });
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  }, 75_000);

  it.each(["restart", "stop", "configure", "repair", "shutdown", "mode-switch", "helper-replace"] as const)(
    "preserves memory-only conversations with unfinished work for %s and lets the user cancel", async kind => {
      const f = await lifecycleFixture();
      try {
        const original = await f.supervisor.start();
        f.update({ activeJobs: 0, memoryOnlyThreads: 1, protectedMemoryOnlyThreads: 1,
          discardableMemoryOnlyThreads: 0 });
        const intent = await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind, force: false,
          ...(kind === "configure" ? { configuration: { maximumAccess: "workspace-write" as const } } : {}),
          ...(kind === "helper-replace" ? { targetBuildId: "next-build" } : {}) });
        await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("blocked"));
        expect((await f.supervisor.health()).pid).toBe(original.pid);
        expect(f.supervisor.cancelLifecycle(intent.requestId).phase).toBe("cancelled");
        f.update({ activeJobs: 0, memoryOnlyThreads: 0, protectedMemoryOnlyThreads: 0,
          discardableMemoryOnlyThreads: 0 });
        expect((await f.supervisor.health()).pid).toBe(original.pid);
      } finally { await f.supervisor.close({ runtime: "force-stop" }); }
    });

  it("allows a safe restart when only completed memory-only contexts remain", async () => {
    const f = await lifecycleFixture();
    try {
      const original = await f.supervisor.start();
      f.update({ activeJobs: 0, memoryOnlyThreads: 2, protectedMemoryOnlyThreads: 0,
        discardableMemoryOnlyThreads: 2 });
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("completed"), {
        timeout: 6000,
        interval: 50
      });
      expect((await f.supervisor.health()).pid).not.toBe(original.pid);
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it("preserves an unconfirmed completion and its exact result across a safe helper restart", async () => {
    const root = temporaryDirectory();
    const stateFile = path.join(root, "state.sqlite");
    const scopeId = "12800000-0000-4000-8000-000000000001";
    const jobId = "12800000-0000-4000-8000-000000000002";
    const requestId = "12800000-0000-4000-8000-000000000003";
    const owner = "12800000-0000-4000-8000-000000000004";
    const original = new BridgeStateStore({ file: stateFile });
    original.upsertJob({
      jobId,
      scopeId,
      requestId,
      status: "completed",
      updatedAt: 2,
      result: { content: [{ type: "text", text: "retained after helper restart" }] }
    } as any);
    const completion = original.getJobCompletionDelivery(jobId, scopeId)!;
    original.claimJobCompletionDelivery(jobId, scopeId, owner, 1_000, 10);
    original.markJobCompletionAcceptanceUnknown({
      jobId,
      scopeId,
      receipt: completion.receipt,
      leaseOwner: owner,
      now: 11
    });
    original.close();

    const f = await lifecycleFixture();
    try {
      const runtime = await f.supervisor.start();
      f.update({ activeJobs: 0, memoryOnlyThreads: 1, protectedMemoryOnlyThreads: 0,
        discardableMemoryOnlyThreads: 1 });
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("completed"), {
        timeout: 6_000,
        interval: 50
      });
      expect((await f.supervisor.health()).pid).not.toBe(runtime.pid);

      const restarted = new BridgeStateStore({ file: stateFile });
      try {
        expect(restarted.getJobCompletionDelivery(jobId, scopeId)).toMatchObject({
          receipt: completion.receipt,
          state: "acceptance-unknown",
          attemptCount: 1,
          completionResultOfferedAt: undefined,
          directResultOfferedAt: undefined
        });
        expect(restarted.countJobs()).toBe(1);
        expect(restarted.listJobs()).toEqual([
          expect.objectContaining({
            jobId,
            requestId,
            result: { content: [{ type: "text", text: "retained after helper restart" }] }
          })
        ]);
        restarted.recordJobCompletionResultOffer({
          scopeId,
          source: "direct-job-query",
          jobId,
          now: 12
        });
        expect(restarted.getJobCompletionDelivery(jobId, scopeId)).toMatchObject({
          state: "acceptance-unknown",
          directResultOfferedAt: 12
        });
        expect(restarted.countJobs()).toBe(1);
      } finally {
        restarted.close();
      }
    } finally {
      await f.supervisor.close({ runtime: "force-stop" });
    }
  });

  it("rejects a superseded CLI target and leaves the old runtime running", async () => {
    const f = await lifecycleFixture();
    try {
      const original = await f.supervisor.start();
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "restart", force: false });
      await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.reasons[0]?.code).toBe("active-jobs"));
      vi.spyOn(f.manager, "activationTarget").mockResolvedValue({ revision: 99, command: "new-cli", description: "changed" });
      f.update({ activeJobs: 0 });
      await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("failed"));
      expect(f.supervisor.lifecycleStatus()?.error).toContain("LIFECYCLE_TARGET_CHANGED");
      expect((await f.supervisor.health()).pid).toBe(original.pid);
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });

  it("does not let automatic crash recovery override a pending stop", async () => {
    const f = await lifecycleFixture(true);
    try {
      const original = await f.supervisor.start();
      await f.supervisor.requestLifecycle({ requestId: randomUUID(), kind: "stop", force: false });
      process.kill(original.pid!, "SIGKILL");
      await vi.waitFor(() => expect(f.supervisor.lifecycleStatus()?.phase).toBe("completed"), { timeout: 6000 });
      expect(await f.supervisor.health()).toMatchObject({ phase: "stopped", pid: null });
      const started = await f.supervisor.start();
      expect(started.phase).toBe("running");
      expect(f.supervisor.lifecycleStatus()?.kind).toBe("start");
    } finally { await f.supervisor.close({ runtime: "force-stop" }); }
  });
});

async function lifecycleFixture(autoRestart = false, codexCommand?: string) {
  const root = temporaryDirectory(), bridgeRoot = path.join(root, "runtime"), envFile = path.join(root, "c", ".env");
  const bridgeSocketPath = path.join(root, "c", "run", "bridge.sock"), launcherPath = path.join(bridgeRoot, "launcher.mjs");
  mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
  writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "");
  const admissionFile = path.join(root, "admission.json");
  const update = (state: Record<string, number>) => writeFileSync(admissionFile, JSON.stringify(state));
  update({ activeJobs: 1 });
  writeFakeLauncher(launcherPath, path.join(root, "arguments.json"), { admissionFile, writeRuntimeLock: true });
  updateRuntimeEnvFile(envFile, { apiKey: "sk-lifecycle-test-1234567890123456", tunnelId: "tunnel_oooooooooooooooooooooooooooooooo" });
  const manager = new CodexRuntimeManager({ root: path.join(root, "cli"),
    discoverExternal: Boolean(codexCommand), ...(codexCommand ? { explicitCommand: codexCommand, appPaths: [] } : {}) });
  const supervisor = new MacOSBridgeSupervisor({ bridgeRoot, envFile, bridgeSocketPath, launcherPath,
    runtimeLockDirectory: path.join(root, "c", "run", "launcher.lock"), codexRuntimeManager: manager,
    registeredProjectRoots: () => [], autoRestart, lifecycleIntervalMs: 60_000, startTimeoutMs: 5000 });
  return { supervisor, manager, update, root, envFile };
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("macOS runtime helper RPC", () => {
  it("allows supported state schemas to reach migration while retaining the project path guard", async () => {
    const root = temporaryDirectory();
    const stateDatabaseFile = path.join(root, "state.sqlite");
    const project = path.join(root, "project");
    createSchema18Fixture(stateDatabaseFile, { projectCwd: project });

    const validEnvFile = path.join(root, "config", ".env");
    writeStateBackedRuntimeEnv(validEnvFile, stateDatabaseFile);
    const valid = new MacOSBridgeSupervisor({
      bridgeRoot: path.join(root, "runtime"),
      envFile: validEnvFile,
      bridgeSocketPath: path.join(root, "valid.sock"),
      runtimeLockDirectory: path.join(root, "valid-run", "launcher.lock")
    });
    try {
      expect((await valid.health()).configuration).toMatchObject({ valid: true });
    } finally {
      await valid.close({ runtime: "force-stop" });
    }

    const conflictingEnvFile = path.join(project, ".runtime", ".env");
    writeStateBackedRuntimeEnv(conflictingEnvFile, stateDatabaseFile);
    const conflicting = new MacOSBridgeSupervisor({
      bridgeRoot: path.join(root, "runtime"),
      envFile: conflictingEnvFile,
      bridgeSocketPath: path.join(root, "conflicting.sock"),
      runtimeLockDirectory: path.join(root, "conflicting-run", "launcher.lock")
    });
    try {
      expect((await conflicting.health()).configuration).toMatchObject({
        valid: false,
        issue: expect.stringContaining("RUNTIME_ENV_PROJECT_CONFLICT")
      });
    } finally {
      await conflicting.close({ runtime: "force-stop" });
    }
  });

  it("allows the earliest supported state schema and rejects a future schema", async () => {
    const root = temporaryDirectory();
    const schema3File = path.join(root, "schema-3.sqlite");
    createSeededSchema3Fixture(schema3File);
    const schema3EnvFile = path.join(root, "schema-3", ".env");
    writeStateBackedRuntimeEnv(schema3EnvFile, schema3File);
    const schema3 = new MacOSBridgeSupervisor({
      bridgeRoot: path.join(root, "runtime"),
      envFile: schema3EnvFile,
      bridgeSocketPath: path.join(root, "schema-3.sock"),
      runtimeLockDirectory: path.join(root, "schema-3-run", "launcher.lock")
    });
    try {
      expect((await schema3.health()).configuration).toMatchObject({ valid: true });
    } finally {
      await schema3.close({ runtime: "force-stop" });
    }

    const futureFile = path.join(root, "schema-32.sqlite");
    createSeededSchema3Fixture(futureFile);
    const futureDatabase = new Database(futureFile);
    futureDatabase.prepare("UPDATE bridge_meta SET value = '32' WHERE key = 'schema_version'").run();
    futureDatabase.close();
    const futureEnvFile = path.join(root, "schema-32", ".env");
    writeStateBackedRuntimeEnv(futureEnvFile, futureFile);
    const future = new MacOSBridgeSupervisor({
      bridgeRoot: path.join(root, "runtime"),
      envFile: futureEnvFile,
      bridgeSocketPath: path.join(root, "schema-32.sock"),
      runtimeLockDirectory: path.join(root, "schema-32-run", "launcher.lock")
    });
    try {
      expect((await future.health()).configuration).toMatchObject({
        valid: false,
        issue: expect.stringContaining("state schema 32")
      });
    } finally {
      await future.close({ runtime: "force-stop" });
    }
  });

  it("falls back to admission only when an older companion explicitly rejects health", async () => {
    for (const code of [-32600, -32601, -32603]) {
      const root = temporaryDirectory();
      const socketPath = path.join(root, "bridge.sock");
      const methods: string[] = [];
      servers.push(await startPrivateJsonLineServer({
        socketPath, maxRequestBytes: 4096, maxResponseBytes: 4096,
        async dispatch(line) {
          const { id, method } = JSON.parse(line);
          methods.push(method);
          return method === "runtime.health"
            ? { jsonrpc: "2.0", id, error: { code, message: "fixture health rejection" } }
            : { jsonrpc: "2.0", id, result: { acceptingNewJobs: true, activeJobs: 0, pendingAdmissions: 0 } };
        },
        requestTooLarge: () => ({}), internalError: () => ({})
      }));
      const supervisor = new MacOSBridgeSupervisor({ bridgeRoot: root, envFile: path.join(root, ".env"), bridgeSocketPath: socketPath,
        runtimeLockDirectory: path.join(root, "run", "launcher.lock") });
      const health = await supervisor.health();
      expect(health.bridge.connected).toBe(code !== -32603);
      expect(health.bridge.observation).toBe(code !== -32603 ? "fresh" : "failed");
      expect(methods).toEqual(code === -32603 ? ["runtime.health"] : ["runtime.health", "runtime.snapshot"]);
    }
  });

  it("projects a state storage failure without marking the companion disconnected", async () => {
    const root = temporaryDirectory();
    const socketPath = path.join(root, "bridge.sock");
    servers.push(await startPrivateJsonLineServer({
      socketPath,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      async dispatch(line) {
        const { id } = JSON.parse(line);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            acceptingNewJobs: false,
            activeJobs: 0,
            pendingAdmissions: 0,
            backgroundProcessState: "confirmed",
            backgroundProcesses: 0,
            backgroundProcessAgents: 0,
            backgroundProcessUnknownAgents: 0,
            stateService: {
              status: "state-recovering",
              storageError: "full",
              storageErrorObservedAt: 1_790_031_000_000
            }
          }
        };
      },
      requestTooLarge: () => ({}),
      internalError: () => ({})
    }));
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot: root,
      envFile: path.join(root, ".env"),
      bridgeSocketPath: socketPath,
      runtimeLockDirectory: path.join(root, "run", "launcher.lock")
    });
    const health = await supervisor.health();
    expect(health.bridge).toMatchObject({
      connected: true,
      observation: "fresh",
      acceptingNewJobs: false,
      stateServiceStatus: "state-recovering",
      stateServiceStorageError: "full",
      stateServiceStorageErrorObservedAt: 1_790_031_000_000
    });
  });

  it("keeps health independent of installation discovery and account queries", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "helper-health-"));
    const manager = new CodexRuntimeManager({ root: path.join(root, "runtime"), discoverExternal: false });
    const snapshot = vi.spyOn(manager, "snapshot").mockImplementation(() => new Promise(() => undefined));
    const controller = new MacOSBridgeSupervisor({ bridgeRoot: root, envFile: path.join(root, ".env"),
      bridgeSocketPath: path.join(root, "bridge.sock"), codexRuntimeManager: manager,
      runtimeLockDirectory: path.join(root, "run", "launcher.lock") });
    const socketPath = path.join(root, "helper.sock");
    const server = await startMacOSHelperServer({ socketPath, controller });
    servers.push(server);
    const result = await request(socketPath, { jsonrpc: "2.0", id: 1, method: "helper.health", params: {} });
    expect(result).toMatchObject({ result: { kind: "helper-status", phase: "stopped" } });
    expect(snapshot).not.toHaveBeenCalled();
    expect((result.result as Record<string, unknown>).codexRuntime).toBeUndefined();
  });

  it("ignores unchanged tunnel heartbeats and invalidates cached configuration on file changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "helper-changes-"));
    const envFile = path.join(root, ".env");
    updateRuntimeEnvFile(envFile, { apiKey: "sk-native-test-1234567890123456", tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn" });
    const runtimeStatusFile = path.join(root, "launcher-status.json");
    const state = { phase: "running", runtimeBuildId: "test", tunnel: { phase: "connected", profile: "managed", transport: "stdio",
      doctorPassed: true, processRunning: true, connected: true, lastCheckedAt: new Date().toISOString(), lastError: null, lastProblem: null } };
    writeManagedRuntimeStatus(runtimeStatusFile, state);
    const controller = new MacOSBridgeSupervisor({ bridgeRoot: root, envFile, runtimeStatusFile,
      bridgeSocketPath: path.join(root, "bridge.sock"), registeredProjectRoots: () => [],
      runtimeLockDirectory: path.join(root, "run", "launcher.lock") });
    const changes: string[] = [];
    const unsubscribe = controller.subscribeChanges(topic => changes.push(topic));
    try {
      expect((await controller.health()).configuration.valid).toBe(true);
      writeManagedRuntimeStatus(runtimeStatusFile, { ...state, tunnel: { ...state.tunnel, lastCheckedAt: new Date(Date.now() + 1).toISOString() } });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(changes).not.toContain("runtime");
      writeManagedRuntimeStatus(runtimeStatusFile, { ...state, tunnel: { ...state.tunnel, connected: false, phase: "degraded" } });
      await vi.waitFor(() => expect(changes).toContain("runtime"));
      writeFileSync(envFile, "", { mode: 0o600 });
      await vi.waitFor(() => expect(changes).toContain("configuration"));
      expect((await controller.health()).configuration.valid).toBe(false);
    } finally { unsubscribe(); }
  });

  it("delivers a lifecycle change before the next health poll", async () => {
    const controller = fakeController();
    let listener: (topic: string) => void = () => undefined;
    controller.subscribeChanges = callback => { listener = callback; return () => undefined; };
    const socketPath = temporarySocketPath();
    servers.push(await startMacOSHelperServer({ socketPath, controller }));
    const first = await request(socketPath, { jsonrpc: "2.0", id: 1, method: "changes.wait", params: { waitMs: 0 } });
    const revision = (first.result as { revision: string }).revision;
    const waiting = request(socketPath, { jsonrpc: "2.0", id: 2, method: "changes.wait", params: { after: revision } });
    listener("runtime");
    expect(await waiting).toMatchObject({ result: { topics: ["runtime"] } });
    expect(controller.snapshot).not.toHaveBeenCalled();
  });

  it("serves a versioned, private control surface", async () => {
    const socketPath = temporarySocketPath();
    const server = await startMacOSHelperServer({
      socketPath,
      controller: fakeController()
    });
    servers.push(server);

    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "hello",
      method: "helper.hello",
      params: {}
    });
    expect(response).toMatchObject({
      result: {
        protocol: {
          name: MACOS_HELPER_PROTOCOL_NAME,
          version: MACOS_HELPER_PROTOCOL_VERSION
        },
        status: { kind: "helper-status", phase: "running" }
      }
    });
    expect(response.result.capabilities).not.toContain("auth.codex-browser-login");
  });

  it("routes setup and explicit drain or force semantics", async () => {
    const socketPath = temporarySocketPath();
    const controller = fakeController();
    const server = await startMacOSHelperServer({ socketPath, controller });
    servers.push(server);

    const secret = "sk-native-test-1234567890123456";
    const discovery = await request(socketPath, {
      jsonrpc: "2.0",
      id: "setup-discovery",
      method: "setup.discover",
      params: {}
    });
    expect(discovery).toMatchObject({
      result: {
        kind: "setup-discovery",
        candidates: [{
          id: "setup_aaaaaaaaaaaaaaaaaaaaaaaa",
          tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
          hasApiKey: true
        }]
      }
    });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "setup-import",
      method: "setup.import",
      params: {
        candidateId: "setup_aaaaaaaaaaaaaaaaaaaaaaaa",
        mode: "drain",
        timeoutMs: 60_000
      }
    });
    expect(controller.importSetup).toHaveBeenCalledWith({
      candidateId: "setup_aaaaaaaaaaaaaaaaaaaaaaaa",
      mode: "drain",
      timeoutMs: 60_000
    });

    const setup = await request(socketPath, {
      jsonrpc: "2.0",
      id: "setup",
      method: "setup.apply",
      params: {
        apiKey: secret,
        tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        mode: "drain",
        timeoutMs: 60_000
      }
    });
    expect(controller.applyConfiguration).toHaveBeenCalledWith({
      apiKey: secret,
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
      mode: "drain",
      timeoutMs: 60_000
    });
    expect(JSON.stringify(setup)).not.toContain(secret);

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "runtime-configure",
      method: "runtime.configure",
      params: {
        defaultBackend: "app-server",
        maximumAccess: "full-access",
        mode: "drain",
        timeoutMs: 60_000
      }
    });
    expect(controller.applyConfiguration).toHaveBeenLastCalledWith({
      defaultBackend: "app-server",
      maximumAccess: "full-access",
      mode: "drain",
      timeoutMs: 60_000
    });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "repair-permissions",
      method: "setup.repair-permissions",
      params: {}
    });
    expect(controller.repairConfigurationPermissions).toHaveBeenCalledOnce();

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "stop",
      method: "runtime.stop",
      params: { mode: "drain", timeoutMs: 30_000 }
    });
    expect(controller.stop).toHaveBeenCalledWith({ mode: "drain", timeoutMs: 30_000 });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "prepare-shutdown",
      method: "helper.prepare-shutdown",
      params: { mode: "force", timeoutMs: 5_000 }
    });
    expect(controller.prepareShutdown).toHaveBeenCalledWith({ mode: "force", timeoutMs: 5_000 });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "restart",
      method: "runtime.restart",
      params: { mode: "force", timeoutMs: 5_000 }
    });
    expect(controller.restart).toHaveBeenCalledWith({ mode: "force", timeoutMs: 5_000 });

    await request(socketPath, {
      jsonrpc: "2.0",
      id: "repair",
      method: "runtime.repair",
      params: { mode: "drain", timeoutMs: 60_000 }
    });
    expect(controller.repair).toHaveBeenCalledWith({ mode: "drain", timeoutMs: 60_000 });
  });

  it("redacts credential-shaped text from helper failures", async () => {
    const socketPath = temporarySocketPath();
    const controller = fakeController();
    vi.mocked(controller.applyConfiguration).mockRejectedValueOnce(
      new Error(
        'failed for sk-leaked.1234567890123456+suffix=secret, tunnel_leaked123, Bearer abcdefghijklmnop, PASSWORD=hunter2-secret, "access_token":"jwt.payload.signature", Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l=='
      )
    );
    const server = await startMacOSHelperServer({ socketPath, controller });
    servers.push(server);

    const response = await request(socketPath, {
      jsonrpc: "2.0",
      id: "redaction",
      method: "setup.apply",
      params: { apiKey: "", tunnelId: "", mode: "drain", timeoutMs: 60_000 }
    });
    expect(response).toMatchObject({ id: "redaction", error: { code: -32602 } });
    expect(JSON.stringify(response)).not.toContain("sk-leaked");
    expect(JSON.stringify(response)).not.toContain("suffix=secret");
    expect(JSON.stringify(response)).not.toContain("tunnel_leaked123");
    expect(JSON.stringify(response)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(response)).not.toContain("hunter2-secret");
    expect(JSON.stringify(response)).not.toContain("jwt.payload.signature");
    expect(JSON.stringify(response)).not.toContain("YWxhZGRpbjpvcGVuc2VzYW1l");
  });

  it("creates a private dotenv and starts the runtime on a fresh install", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configDirectory = path.join(root, "c");
    const configFile = path.join(configDirectory, ".env");
    const bridgeSocket = path.join(configDirectory, "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile);
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000,
      registeredProjectRoots: () => [path.join(root, "safe-project")]
    });

    try {
      const applied = await supervisor.applyConfiguration({
        apiKey: "sk-supervisor-1234567890123456",
        tunnelId: "tunnel_ffffffffffffffffffffffffffffffff",
        mode: "drain",
        timeoutMs: 5_000
      });
      expect(applied.status.phase).toBe("running");
      expect(applied.status).toMatchObject({
        lastProblem: null,
        configuration: { issueProblem: null },
        tunnel: { lastProblem: null, transport: "http", connected: true }
      });
      expect(applied.configuration).toMatchObject({
        exists: true,
        valid: true,
        hasApiKey: true,
        tunnelId: "tunnel_ffffffffffffffffffffffffffffffff"
      });
      expect(JSON.parse(readFileSync(argumentsFile, "utf8"))).toEqual(
        expect.arrayContaining(["--transport", "http"])
      );
      expect(lstatSync(configDirectory).mode & 0o777).toBe(0o700);
      expect(lstatSync(configFile).mode & 0o777).toBe(0o600);
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("imports a discovered tunnel-client profile without returning its secret", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configDirectory = path.join(root, "config");
    const configFile = path.join(configDirectory, ".env");
    const bridgeSocket = path.join(configDirectory, "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    const profileDirectory = path.join(root, "tunnel-profiles");
    const secret = "sk-discovered-1234567890123456";
    const tunnelId = "tunnel_dddddddddddddddddddddddddddddddd";
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    mkdirSync(profileDirectory, { mode: 0o700 });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFileSync(path.join(profileDirectory, "existing.yaml"), [
      "control_plane:",
      `  tunnel_id: \"${tunnelId}\"`,
      "  api_key: \"env:OPENAI_API_KEY\"",
      ""
    ].join("\n"), { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile);
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000,
      registeredProjectRoots: () => [path.join(root, "safe-project")],
      setupDiscoveryEnvironment: { OPENAI_API_KEY: secret },
      setupDiscoveryProfileDirectory: profileDirectory
    });

    try {
      const discovery = await supervisor.discoverSetup();
      expect(discovery.candidates).toEqual([
        expect.objectContaining({
          source: "tunnel-client-profile",
          profileName: "existing",
          tunnelId,
          hasApiKey: true,
          apiKeySource: "profile-environment"
        })
      ]);
      expect(JSON.stringify(discovery)).not.toContain(secret);

      const imported = await supervisor.importSetup({
        candidateId: discovery.candidates[0].id,
        mode: "drain",
        timeoutMs: 5_000
      });
      expect(imported.status.phase).toBe("running");
      expect(imported.configuration).toMatchObject({ valid: true, tunnelId });
      expect(JSON.stringify(imported)).not.toContain(secret);
      expect(readFileSync(configFile, "utf8")).toContain("CONTROL_PLANE_API_KEY=");
      expect(lstatSync(configFile).mode & 0o777).toBe(0o600);
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("does not reuse an administrator key already present in the runtime dotenv", async () => {
    const root = temporaryDirectory();
    const configDirectory = path.join(root, "config");
    const configFile = path.join(configDirectory, ".env");
    const profileDirectory = path.join(root, "tunnel-profiles");
    const tunnelId = "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    mkdirSync(configDirectory, { mode: 0o700 });
    mkdirSync(profileDirectory, { mode: 0o700 });
    writeFileSync(configFile, [
      "CONTROL_PLANE_API_KEY=sk-admin-12345678901234567890",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ""
    ].join("\n"), { mode: 0o600 });
    writeFileSync(path.join(profileDirectory, "id-only.yaml"), [
      "control_plane:",
      `  tunnel_id: "${tunnelId}"`,
      ""
    ].join("\n"), { mode: 0o600 });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot: path.join(root, "runtime"),
      envFile: configFile,
      bridgeSocketPath: path.join(configDirectory, "run", "bridge.sock"),
      launcherPath: path.join(root, "unused-launcher.mjs"),
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      setupDiscoveryEnvironment: {},
      setupDiscoveryProfileDirectory: profileDirectory
    });

    try {
      const discovery = await supervisor.discoverSetup();
      const candidate = discovery.candidates.find((entry) => entry.tunnelId === tunnelId);
      expect(candidate).toMatchObject({ hasApiKey: false, apiKeySource: "none" });
      await expect(supervisor.importSetup({
        candidateId: candidate!.id,
        mode: "drain",
        timeoutMs: 5_000
      })).rejects.toThrow(/SETUP_API_KEY_UNAVAILABLE/);
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("atomically applies configuration and restarts the managed runtime", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile);
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor.1234567890123456+suffix=secret",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      codexRuntimeManager: new CodexRuntimeManager({
        root: path.join(root, "codex-runtime"),
        discoverExternal: false
      }),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      expect(JSON.parse(readFileSync(argumentsFile, "utf8"))).toContain("--reuse-profile");

      const applied = await supervisor.applyConfiguration({
        tunnelId: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
        mode: "force",
        timeoutMs: 5_000
      });
      expect(applied.status.phase).toBe("running");
      expect(applied.configuration.tunnelId).toBe("tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr");
      expect(JSON.parse(readFileSync(argumentsFile, "utf8"))).toContain("--reuse-profile");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("redacts secrets split across runtime output chunks", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { splitRuntimeSecret: true });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const logs = supervisor.logs(200).map((entry) => entry.message).join("\n");
      expect(logs).toContain("[REDACTED_API_KEY]");
      expect(logs).not.toContain("sk-split.secret");
      expect(logs).not.toContain("1234567890123456");
      expect(logs).not.toContain("=suffix");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it.each([
    { label: "a different tunnel profile", runtimeProfile: "codex-mcp-bridge" },
    { label: "the legacy stdio transport", runtimeTransport: "stdio" }
  ])("rejects launcher readiness from $label", async (runtimeIdentity) => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, runtimeIdentity);
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 500
    });

    try {
      await expect(supervisor.start()).rejects.toThrow(
        "Timed out waiting for the bridge companion and Secure MCP Tunnel readiness"
      );
      expect((await supervisor.snapshot()).phase).toBe("stopped");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("tolerates a 750ms status response and retains bounded failure and recovery diagnostics", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const delayFile = path.join(root, "snapshot-delay");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFileSync(delayFile, "0");
    writeFakeLauncher(launcher, path.join(root, "arguments.json"), { healthDelayFile: delayFile });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot, envFile: configFile, bridgeSocketPath: bridgeSocket, launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "launcher.lock"), autoRestart: false, startTimeoutMs: 5_000
    });
    try {
      const started = await supervisor.start();
      expect(started.bridge).toMatchObject({ connected: true, observation: "fresh" });
      expect(started.bridge.lastSuccessfulAt).toEqual(expect.any(String));
      writeFileSync(delayFile, "750");
      const delayed = await supervisor.snapshot();
      expect(delayed).toMatchObject({
        phase: "running", pid: started.pid,
        bridge: { connected: true, observation: "fresh", lastSuccessfulAt: expect.any(String) },
        lastExit: null, restartAttempt: 0
      });
      const lastSuccessfulAt = delayed.bridge.lastSuccessfulAt;
      writeFileSync(delayFile, "2300");
      const failures = await Promise.all([supervisor.snapshot(), supervisor.snapshot()]);
      expect(failures.every(status => !status.bridge.connected && status.pid === started.pid &&
        status.bridge.observation === "timed-out" && status.bridge.lastSuccessfulAt === lastSuccessfulAt)).toBe(true);
      await supervisor.snapshot();
      let messages = supervisor.logs(200).map(entry => entry.message);
      expect(messages.filter(message => message.includes("Bridge status check failed"))).toHaveLength(1);
      expect(messages.some(message => message.includes("Bridge companion request timed out"))).toBe(true);
      writeFileSync(delayFile, "0");
      expect(await supervisor.snapshot()).toMatchObject({
        bridge: { connected: true, observation: "fresh", lastSuccessfulAt: expect.any(String) },
        lastExit: null, restartAttempt: 0
      });
      messages = supervisor.logs(200).map(entry => entry.message);
      expect(messages.filter(message => message.includes("Bridge status check recovered"))).toHaveLength(1);
    } finally {
      writeFileSync(delayFile, "0");
      await supervisor.close({ runtime: "force-stop" });
    }
  }, 15_000);

  it("does not change the dotenv when active work misses the drain deadline", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { activeJobs: 1 });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const original = readFileSync(configFile, "utf8");
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.applyConfiguration({
        tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        mode: "drain",
        timeoutMs: 1_000
      })).rejects.toThrow("DRAIN_TIMEOUT");
      expect(readFileSync(configFile, "utf8")).toBe(original);
      expect((await supervisor.snapshot()).phase).toBe("running");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("requires force when verified background processes would be interrupted", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { backgroundProcesses: 2 });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.stop({ mode: "drain", timeoutMs: 5_000 }))
        .rejects.toThrow("BACKGROUND_PROCESSES_ACTIVE");
      expect((await supervisor.snapshot()).phase).toBe("running");
      expect(await request(bridgeSocket, {
        jsonrpc: "2.0",
        id: "admission-after-background-block",
        method: "runtime.snapshot",
        params: {}
      })).toMatchObject({ result: { acceptingNewJobs: true } });

      const stopped = await supervisor.stop({ mode: "force", timeoutMs: 5_000 });
      expect(stopped).toMatchObject({ phase: "stopped", pid: null });
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("blocks graceful stop when background process impact cannot be verified", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { backgroundProcessUnknownAgents: 1 });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.stop({ mode: "drain", timeoutMs: 5_000 }))
        .rejects.toThrow("BACKGROUND_PROCESS_STATE_UNKNOWN");
      expect(await supervisor.snapshot()).toMatchObject({
        phase: "running",
        lastError: expect.stringContaining("BACKGROUND_PROCESS_STATE_UNKNOWN")
      });
      expect(supervisor.logs(20)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "helper",
          message: expect.stringContaining("Graceful runtime stop was blocked")
        })
      ]));

      const stopped = await supervisor.stop({ mode: "force", timeoutMs: 5_000 });
      expect(stopped).toMatchObject({ phase: "stopped", pid: null, lastError: null });
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it.runIf(process.platform !== "win32")(
    "force stop verifies and removes detached descendants from the managed runtime tree",
    async () => {
      const root = temporaryDirectory();
      const bridgeRoot = path.join(root, "runtime");
      const configFile = path.join(root, "config", ".env");
      const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
      const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
      const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
      const descendantPidFile = path.join(root, "detached-descendant.pid");
      mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
      writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
      writeFakeLauncher(launcher, argumentsFile, { detachedDescendantPidFile: descendantPidFile });
      updateRuntimeEnvFile(configFile, {
        apiKey: "sk-supervisor-1234567890123456",
        tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
      });
      const supervisor = new MacOSBridgeSupervisor({
        bridgeRoot,
        envFile: configFile,
        bridgeSocketPath: bridgeSocket,
        launcherPath: launcher,
        runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
        autoRestart: false,
        startTimeoutMs: 5_000
      });
      let descendantPid = 0;

      try {
        await supervisor.start();
        await eventually(() => existsAndHasContent(descendantPidFile));
        descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
        expect(processAlive(descendantPid)).toBe(true);

        const stopped = await supervisor.stop({ mode: "force", timeoutMs: 5_000 });

        expect(stopped).toMatchObject({ phase: "stopped", pid: null });
        await eventually(() => !processAlive(descendantPid));
      } finally {
        if (descendantPid > 1 && processAlive(descendantPid)) {
          try { process.kill(-descendantPid, "SIGKILL"); } catch {}
        }
        await supervisor.close({ runtime: "force-stop" });
      }
    },
    15_000
  );

  it("re-enables admissions when a graceful-stop status request fails", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, {
      activeJobs: 1,
      failSnapshotAfterDrain: true
    });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.stop({ mode: "drain", timeoutMs: 5_000 }))
        .rejects.toThrow();
      expect(await request(bridgeSocket, {
        jsonrpc: "2.0",
        id: "admission-after-failed-drain",
        method: "runtime.snapshot",
        params: {}
      })).toMatchObject({ result: { acceptingNewJobs: true } });
      expect((await supervisor.snapshot()).phase).toBe("running");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("rechecks memory-only sessions after closing admission and preserves the running backend", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime"), configFile = path.join(root, "c", ".env");
    const bridgeSocket = path.join(root, "c", "run", "bridge.sock"), launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "");
    writeFakeLauncher(launcher, path.join(root, "args.json"), { memoryOnlyAfterDrain: 1 });
    updateRuntimeEnvFile(configFile, { apiKey: "sk-supervisor-1234567890123456", tunnelId: "tunnel_oooooooooooooooooooooooooooooooo", defaultBackend: "app-server" });
    const original = readFileSync(configFile, "utf8");
    const supervisor = new MacOSBridgeSupervisor({ bridgeRoot, envFile: configFile, bridgeSocketPath: bridgeSocket,
      launcherPath: launcher, runtimeLockDirectory: path.join(root, "launcher.lock"), autoRestart: false, startTimeoutMs: 5000 });
    try {
      const started = await supervisor.start();
      await expect(supervisor.applyConfiguration({ defaultBackend: "app-server", maximumAccess: "workspace-write", mode: "drain", timeoutMs: 5000 })).rejects.toThrow("CODEX_APPLY_PENDING");
      expect(readFileSync(configFile, "utf8")).toBe(original);
      expect((await supervisor.snapshot()).pid).toBe(started.pid);
      expect(await request(bridgeSocket, { jsonrpc: "2.0", id: "check", method: "runtime.snapshot", params: {} })).toMatchObject({ result: { acceptingNewJobs: true } });
    } finally { await supervisor.close({ runtime: "force-stop" }); }
  });

  it("rolls back the dotenv and restores the old runtime when new startup fails", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, {
      failTunnelId: "tunnel_ssssssssssssssssssssssssssssssss"
    });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const original = readFileSync(configFile, "utf8");
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.applyConfiguration({
        tunnelId: "tunnel_ssssssssssssssssssssssssssssssss",
        mode: "force",
        timeoutMs: 5_000
      })).rejects.toThrow("Previous runtime configuration was restored");
      expect(readFileSync(configFile, "utf8")).toBe(original);
      const status = await supervisor.snapshot();
      expect(status.phase).toBe("running");
      expect(status.configuration.tunnelId).toBe("tunnel_oooooooooooooooooooooooooooooooo");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("restarts the unchanged runtime when a concurrent dotenv edit prevents commit", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const bridgeSocket = path.join(root, "config", "run", "bridge.sock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { mutateEnvOnDrain: "# concurrent edit" });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const original = readFileSync(configFile, "utf8");
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      await supervisor.start();
      await expect(supervisor.applyConfiguration({
        tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        mode: "force",
        timeoutMs: 5_000
      })).rejects.toThrow("Runtime configuration was not changed");
      expect(readFileSync(configFile, "utf8")).toBe(`${original}# concurrent edit\n`);
      const status = await supervisor.snapshot();
      expect(status.phase).toBe("running");
      expect(status.configuration.tunnelId).toBe("tunnel_oooooooooooooooooooooooooooooooo");
    } finally {
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("safely adopts an app-managed runtime left behind by a helper crash", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const runDirectory = path.join(root, "config", "run");
    const bridgeSocket = path.join(runDirectory, "bridge.sock");
    const runtimeStatusFile = path.join(runDirectory, "launcher-status.json");
    const runtimeLockDirectory = path.join(runDirectory, "launcher.lock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { writeRuntimeLock: true });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const first = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeStatusFile,
      runtimeLockDirectory,
      autoRestart: false,
      startTimeoutMs: 5_000
    });
    const replacement = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeStatusFile,
      runtimeLockDirectory,
      autoRestart: false,
      startTimeoutMs: 5_000
    });
    const terminator = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeStatusFile,
      runtimeLockDirectory,
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      const original = await first.start();
      unlinkSync(configFile);
      const adopted = await replacement.start();
      expect(adopted).toMatchObject({
        phase: "running",
        pid: original.pid,
        tunnel: { transport: "http", connected: true },
        configuration: { exists: false, valid: false }
      });
      expect(replacement.logs(20).map((entry) => entry.message).join("\n"))
        .toContain("Adopted the existing app-managed runtime");
      expect(JSON.parse(readFileSync(argumentsFile, "utf8")))
        .toEqual(expect.arrayContaining(["--profile", "codex-mcp-bridge-macos"]));

      const stopped = await terminator.stop({ mode: "force", timeoutMs: 5_000 });
      expect(stopped).toMatchObject({ phase: "stopped", pid: null });
      expect(terminator.logs(20).map((entry) => entry.message).join("\n"))
        .toContain("Adopted the existing app-managed runtime");
    } finally {
      await terminator.close({ runtime: "force-stop" });
      await replacement.close({ runtime: "force-stop" });
      await first.close({ runtime: "force-stop" });
    }
  });

  it("adopts and drains an existing runtime before changing its dotenv", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "config", ".env");
    const runDirectory = path.join(root, "config", "run");
    const bridgeSocket = path.join(runDirectory, "bridge.sock");
    const runtimeStatusFile = path.join(runDirectory, "launcher-status.json");
    const runtimeLockDirectory = path.join(runDirectory, "launcher.lock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile, { writeRuntimeLock: true });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    // Adoption must inspect this fixture's authentication and state, including
    // when the user's running Helper has a different connection staged.
    writeFileSync(configFile, readFileSync(configFile, "utf8") +
      `\nCODEX_MCP_BRIDGE_RUNTIME_HOME=${path.join(root, "cli")}\nCODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${path.join(root, "state.sqlite")}\n`,
      { mode: 0o600 });
    const first = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeStatusFile,
      runtimeLockDirectory,
      autoRestart: false,
      startTimeoutMs: 5_000
    });
    const replacement = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeStatusFile,
      runtimeLockDirectory,
      autoRestart: false,
      startTimeoutMs: 5_000
    });

    try {
      const original = await first.start();
      const applied = await replacement.applyConfiguration({
        tunnelId: "tunnel_pppppppppppppppppppppppppppppppp",
        mode: "drain",
        timeoutMs: 5_000
      });
      expect(applied.status.phase).toBe("running");
      expect(applied.status.pid).not.toBe(original.pid);
      expect(readFileSync(configFile, "utf8"))
        .toContain("CONTROL_PLANE_TUNNEL_ID=tunnel_pppppppppppppppppppppppppppppppp");
    } finally {
      await replacement.close({ runtime: "force-stop" });
      await first.close({ runtime: "force-stop" });
    }
  // Includes two five-second startup budgets, a drain and cleanup. The test's
  // total ceiling must not expire before those individually bounded operations.
  }, 20_000);

  it("blocks an older live launcher using the alternate-dotenv lock location", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(root, "alternate", ".env");
    const bridgeSocket = path.join(root, "canonical", "run", "bridge.sock");
    const runtimeLockDirectory = path.join(root, "canonical", "run", "launcher.lock");
    const legacyRuntimeLockDirectory = path.join(root, "alternate", "run", "launcher.lock");
    const launcher = path.join(bridgeRoot, "fake-launcher.mjs");
    const argumentsFile = path.join(bridgeRoot, "last-arguments.json");
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    writeFakeLauncher(launcher, argumentsFile);
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const legacyLock = acquireRuntimeLock(legacyRuntimeLockDirectory);
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: launcher,
      runtimeLockDirectory,
      autoRestart: false,
      startTimeoutMs: 1_000,
      registeredProjectRoots: () => []
    });

    try {
      await expect(supervisor.start()).rejects.toThrow("LEGACY_RUNTIME_DETECTED");
    } finally {
      legacyLock.release();
      await supervisor.close({ runtime: "force-stop" });
    }
  });

  it("rejects a configured dotenv inside any registered project", async () => {
    const root = temporaryDirectory();
    const project = path.join(root, "project");
    const bridgeRoot = path.join(root, "runtime");
    const configFile = path.join(project, ".runtime", ".env");
    const bridgeSocket = path.join(root, "run", "bridge.sock");
    mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(bridgeRoot, "dist"), { recursive: true });
    writeFileSync(path.join(bridgeRoot, "dist", "cli.js"), "", { mode: 0o600 });
    updateRuntimeEnvFile(configFile, {
      apiKey: "sk-supervisor-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo"
    });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: bridgeSocket,
      launcherPath: path.join(bridgeRoot, "missing-launcher.mjs"),
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      registeredProjectRoots: () => [project]
    });

    expect((await supervisor.snapshot()).configuration).toMatchObject({
      valid: false,
      issue: expect.stringContaining("RUNTIME_ENV_PROJECT_CONFLICT")
    });
    await expect(supervisor.start()).rejects.toThrow("RUNTIME_ENV_PROJECT_CONFLICT");

    chmodSync(path.dirname(configFile), 0o755);
    chmodSync(configFile, 0o644);
    await expect(supervisor.repairConfigurationPermissions())
      .rejects.toThrow("RUNTIME_ENV_PROJECT_CONFLICT");
    expect(lstatSync(path.dirname(configFile)).mode & 0o777).toBe(0o755);
    expect(lstatSync(configFile).mode & 0o777).toBe(0o644);
  });

  it("uses Codex command and CODEX_HOME from dotenv without returning raw CLI output", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configDirectory = path.join(root, "config");
    const configFile = path.join(configDirectory, ".env");
    const codexHome = path.join(root, "codex-home");
    const invocationFile = path.join(root, "codex-invocation.json");
    const fakeCodex = path.join(root, "fake-codex.mjs");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import ${JSON.stringify(new URL("./fixtures/app-server-schema-fixture.mjs", import.meta.url).href)};
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.3"); process.exit(0); }
writeFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({
  args: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME
}));
import {createInterface} from "node:readline";
createInterface({input:process.stdin}).on("line", line => {
 const request=JSON.parse(line); if(request.id===undefined)return;
 const result=request.method==="initialize" ? {userAgent:"fixture",platformFamily:"unix",platformOs:"macos"}
   : request.method==="account/read" ? {account:{type:"chatgpt",email:"user@example.com",planType:"plus"}} : {};
 process.stdout.write(JSON.stringify({id:request.id,result})+"\\n");
});
`, { mode: 0o700 });
    writeFileSync(configFile, [
      "CONTROL_PLANE_API_KEY=sk-supervisor-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
      `CODEX_MCP_BRIDGE_CODEX=${fakeCodex}`,
      `CODEX_HOME=${codexHome}`,
      `CODEX_MCP_BRIDGE_RUNTIME_HOME=${path.join(root, "managed-codex")}`,
      ""
    ].join("\n"), { mode: 0o600 });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: path.join(configDirectory, "run", "bridge.sock"),
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      registeredProjectRoots: () => []
    });

    const status = await supervisor.authStatus();
    expect(status).toEqual({
      installed: true,
      authenticated: true,
      resolvedAuthMode: "chatgpt",
      summary: "Codex login is available."
    });
    expect(JSON.stringify(status)).not.toContain("user@example.com");
    expect(JSON.parse(readFileSync(invocationFile, "utf8"))).toEqual({
      args: ["app-server", "--listen", "stdio://"],
      codexHome
    });
    unlinkSync(invocationFile);
    const progress = await supervisor.codexRuntime({ action: "status", includeAccount: false });
    // This fixture has no auth.json identity. A structural status read must
    // avoid reusing numbers from an account whose current identity is unknown.
    expect(progress.account).toBeNull();
    expect(() => readFileSync(invocationFile)).toThrow();
  });

  it("does not report an account read failure as a logged-out Codex account", async () => {
    const root = temporaryDirectory();
    const bridgeRoot = path.join(root, "runtime");
    const configDirectory = path.join(root, "config");
    const configFile = path.join(configDirectory, ".env");
    const fakeCodex = path.join(root, "fake-codex.mjs");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import ${JSON.stringify(new URL("./fixtures/app-server-schema-fixture.mjs", import.meta.url).href)};
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.3"); process.exit(0); }
import {createInterface} from "node:readline";
createInterface({input:process.stdin}).on("line", line => {
 const request=JSON.parse(line); if(request.id===undefined)return;
 if(request.method==="initialize") {
   process.stdout.write(JSON.stringify({id:request.id,result:{userAgent:"fixture",platformFamily:"unix",platformOs:"macos"}})+"\\n");
 } else if(request.method==="account/read") {
   process.stdout.write(JSON.stringify({id:request.id,error:{code:-32000,message:"temporary account read failure"}})+"\\n");
 } else {
   process.stdout.write(JSON.stringify({id:request.id,result:{}})+"\\n");
 }
});
`, { mode: 0o700 });
    writeFileSync(configFile, [
      "CONTROL_PLANE_API_KEY=sk-supervisor-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
      `CODEX_MCP_BRIDGE_CODEX=${fakeCodex}`,
      `CODEX_MCP_BRIDGE_RUNTIME_HOME=${path.join(root, "managed-codex")}`,
      ""
    ].join("\n"), { mode: 0o600 });
    const supervisor = new MacOSBridgeSupervisor({
      bridgeRoot,
      envFile: configFile,
      bridgeSocketPath: path.join(configDirectory, "run", "bridge.sock"),
      runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
      autoRestart: false,
      registeredProjectRoots: () => []
    });

    await expect(supervisor.authStatus()).rejects.toThrow("CODEX_AUTH_STATUS_UNAVAILABLE");
    await expect(supervisor.authStatus()).rejects.toThrow("CODEX_AUTH_STATUS_UNAVAILABLE");
    const diagnostics = supervisor.logs(20).map(entry => entry.message);
    expect(diagnostics.filter(message => message.includes("Codex login status check failed"))).toHaveLength(1);
    expect(diagnostics.join("\n")).toContain("temporary account read failure");
  });

  it.runIf(process.platform !== "win32")(
    "rejects legacy shared-home login from both Helper actions without starting the CLI",
    async () => {
      const root = temporaryDirectory();
      const bridgeRoot = path.join(root, "runtime");
      const configDirectory = path.join(root, "config");
      const configFile = path.join(configDirectory, ".env");
      const processFile = path.join(root, "login-processes.json");
      const fakeCodex = path.join(root, "fake-codex-login.mjs");
      mkdirSync(bridgeRoot, { recursive: true });
      mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(fakeCodex, `#!/usr/bin/env node
import ${JSON.stringify(new URL("./fixtures/app-server-schema-fixture.mjs", import.meta.url).href)};
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.3"); process.exit(0); }
const descendant = spawn(process.execPath, ["-e", "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
  detached: true,
  stdio: "ignore"
});
descendant.unref();
writeFileSync(${JSON.stringify(processFile)}, JSON.stringify({
  loginPid: process.pid,
  descendantPid: descendant.pid
}));
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`, { mode: 0o700 });
      writeFileSync(configFile, [
        "CONTROL_PLANE_API_KEY=sk-supervisor-1234567890123456",
        "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
        `CODEX_MCP_BRIDGE_CODEX=${fakeCodex}`,
        ""
      ].join("\n"), { mode: 0o600 });
      const supervisor = new MacOSBridgeSupervisor({
        bridgeRoot,
        envFile: configFile,
        bridgeSocketPath: path.join(configDirectory, "run", "bridge.sock"),
        runtimeLockDirectory: path.join(root, "runtime-lock", "launcher.lock"),
        autoRestart: false,
        registeredProjectRoots: () => []
      });
      let loginPid = 0;
      let descendantPid = 0;

      try {
        await expect(supervisor.startLogin()).rejects.toThrow("CODEX_SHARED_LOGIN_DISABLED");
        await expect(supervisor.codexRuntime({ action: "login" })).rejects.toThrow("CODEX_SHARED_LOGIN_DISABLED");
        expect(existsAndHasContent(processFile)).toBe(false);
      } finally {
        if (existsAndHasContent(processFile)) {
          ({ loginPid, descendantPid } = JSON.parse(readFileSync(processFile, "utf8")));
        }
        for (const pid of [loginPid, descendantPid]) {
          if (pid > 1 && processAlive(pid)) {
            try { process.kill(-pid, "SIGKILL"); } catch {}
          }
        }
        await supervisor.close({ runtime: "force-stop" }).catch(() => undefined);
      }
    },
    15_000
  );
});

function fakeController(): MacOSHelperController {
  return {
    snapshot: vi.fn(async () => helperStatus()),
    discoverSetup: vi.fn(async () => ({
      kind: "setup-discovery" as const,
      candidates: [{
        id: "setup_aaaaaaaaaaaaaaaaaaaaaaaa",
        source: "environment" as const,
        profileName: null,
        tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
        hasApiKey: true,
        apiKeySource: "control-plane-environment" as const
      }]
    })),
    importSetup: vi.fn(async () => ({
      configuration: helperStatus().configuration,
      status: helperStatus(),
      restarted: true,
      rolledBack: false as const
    })),
    applyConfiguration: vi.fn(async () => ({
      configuration: helperStatus().configuration,
      status: helperStatus(),
      restarted: true,
      rolledBack: false as const
    })),
    repairConfigurationPermissions: vi.fn(async () => helperStatus().configuration),
    authStatus: vi.fn(async () => ({
      installed: true,
      authenticated: true,
      summary: "Logged in"
    })),
    startLogin: vi.fn(async () => ({ started: true as const })),
    prepareShutdown: vi.fn(async () => helperStatus("stopped")),
    start: vi.fn(async () => helperStatus()),
    stop: vi.fn(async () => helperStatus("stopped")),
    restart: vi.fn(async () => helperStatus()),
    repair: vi.fn(async () => helperStatus()),
    logs: vi.fn(() => [])
  };
}

function helperStatus(phase: MacOSHelperStatus["phase"] = "running"): MacOSHelperStatus {
  return {
    kind: "helper-status",
    generatedAt: "2026-09-02T00:00:00.000Z",
    phase,
    pid: phase === "stopped" ? null : 123,
    startedAt: phase === "stopped" ? null : "2026-09-02T00:00:00.000Z",
    lastExit: null,
    lastError: null,
    lastProblem: null,
    restartAttempt: 0,
    configuration: {
      path: "/private/config/.env",
      exists: true,
      valid: true,
      hasApiKey: true,
      hasTunnelId: true,
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
      operatorConfiguration: {
        defaultBackend: "app-server",
        maximumAccess: "read-only"
      },
      issue: null,
      issueProblem: null
    },
    bridge: {
      socketPath: "/private/config/run/bridge.sock",
      connected: true,
      acceptingNewJobs: true,
      activeJobs: 2,
      pendingAdmissions: 0,
      backgroundProcessState: "confirmed",
      backgroundProcesses: 0,
      backgroundProcessAgents: 0,
      backgroundProcessUnknownAgents: 0
    },
    tunnel: {
      phase: "connected",
      profile: "codex-mcp-bridge-stdio",
      transport: "stdio",
      doctorPassed: true,
      processRunning: true,
      connected: true,
      lastCheckedAt: "2026-09-02T00:00:00.000Z",
      lastError: null,
      lastProblem: null
    }
  };
}

function temporarySocketPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "codex-macos-helper-")), "helper.sock");
}

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-macos-supervisor-"));
}

function writeStateBackedRuntimeEnv(envFile: string, stateDatabaseFile: string): void {
  mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
  writeFileSync(envFile, [
    "CONTROL_PLANE_API_KEY=sk-state-migration-test-1234567890",
    "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
    `CODEX_MCP_BRIDGE_STATE_DATABASE_FILE=${stateDatabaseFile}`,
    ""
  ].join("\n"), { mode: 0o600 });
}


function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function existsAndHasContent(file: string): boolean {
  try {
    return readFileSync(file, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

function request(
  socketPath: string,
  payload: Record<string, unknown>
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>);
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.once("error", reject);
  });
}
