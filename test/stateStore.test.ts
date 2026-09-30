import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BridgeStateStore,
  COMPLETION_OUTBOX_UNCERTAIN_HOLD_AT
} from "../src/stateStore.js";

describe("BridgeStateStore", () => {
  it("lists only retryable notify events for the local native delivery path", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const notifyActivityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const verifyActivityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const otherScope = "22222222-2222-4222-8222-222222222222";
    try {
      store.createActivity({
        activityId: notifyActivityId,
        scopeId: SCOPE_A,
        handoffPolicy: "notify",
        completionTrigger: "sealed-jobs-terminal",
        now: 1
      });
      store.upsertJob({ ...job("native-notify", "native-notify-request"), activityId: notifyActivityId, updatedAt: 2 });
      store.sealActivity(notifyActivityId, 3);

      store.createActivity({
        activityId: verifyActivityId,
        scopeId: otherScope,
        handoffPolicy: "verify",
        completionTrigger: "sealed-jobs-terminal",
        now: 1
      });
      store.upsertJob({
        ...job("native-verify", "native-verify-request"),
        scopeId: otherScope,
        activityId: verifyActivityId,
        updatedAt: 2
      });
      store.sealActivity(verifyActivityId, 3);

      const events = store.listPendingNotifyCompletionOutbox();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        activityId: notifyActivityId,
        scopeId: SCOPE_A,
        channel: "notify"
      });

      const claimedAt = Date.now();
      const claimed = store.claimCompletionOutbox(
        events[0]!.outboxId,
        SCOPE_A,
        "native-menu-bar",
        1_000,
        claimedAt
      );
      expect(claimed).toMatchObject({ attemptCount: 1, leaseOwner: "native-menu-bar" });
      expect(store.listPendingNotifyCompletionOutbox()).toEqual([]);
      store.markCompletionOutboxDelivered(events[0]!.outboxId, SCOPE_A, "native-menu-bar", claimedAt + 1);
      expect(store.getCompletionOutbox(events[0]!.outboxId)).toMatchObject({ deliveredAt: claimedAt + 1 });
      expect(store.listCompletionOutbox(verifyActivityId)).toMatchObject([
        { channel: "verify", deliveredAt: undefined }
      ]);
    } finally {
      store.close();
    }
  });

  it("holds an uncertain Dashboard completion dispatch out of automatic retries", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const activityId = "12121212-1212-4212-8212-121212121212";
    try {
      store.createActivity({
        activityId,
        scopeId: SCOPE_A,
        handoffPolicy: "notify",
        completionTrigger: "sealed-jobs-terminal",
        now: 1
      });
      store.upsertJob({ ...job("completion-job", "completion-request"), activityId, updatedAt: 2 });
      store.sealActivity(activityId, 3);

      const [event] = store.listPendingCompletionOutbox(SCOPE_A);
      expect(event).toMatchObject({ activityId, scopeId: SCOPE_A, attemptCount: 0 });
      const leaseOwner = "dashboard-widget";
      expect(store.claimCompletionOutbox(event!.outboxId, SCOPE_A, leaseOwner, 1_000, 3))
        .toMatchObject({ outboxId: event!.outboxId, leaseOwner, attemptCount: 1 });
      const uncertain = store.markCompletionOutboxUncertain(event!.outboxId, SCOPE_A, leaseOwner);
      expect(uncertain).toMatchObject({
        outboxId: event!.outboxId,
        nextAttemptAt: COMPLETION_OUTBOX_UNCERTAIN_HOLD_AT,
        leaseOwner: undefined,
        leaseExpiresAt: undefined
      });
      expect(store.listPendingCompletionOutbox(SCOPE_A)).toEqual([]);
      expect(store.claimCompletionOutbox(event!.outboxId, SCOPE_A, "another-widget", 1_000, 4))
        .toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("keeps a claimed completion outbox event durable across a bridge restart", () => {
    const file = stateFile();
    const activityId = "13131313-1313-4313-8313-131313131313";
    const first = new BridgeStateStore({ file });
    try {
      first.createActivity({
        activityId,
        scopeId: SCOPE_A,
        handoffPolicy: "notify",
        completionTrigger: "sealed-jobs-terminal",
        now: 1
      });
      first.upsertJob({ ...job("restart-completion-job", "restart-completion-request"), activityId, updatedAt: 2 });
      first.sealActivity(activityId, 3);
      const [event] = first.listPendingCompletionOutbox(SCOPE_A);
      expect(event).toMatchObject({ activityId, attemptCount: 0 });
      first.close();

      const restarted = new BridgeStateStore({ file });
      try {
        const [restored] = restarted.listPendingCompletionOutbox(SCOPE_A);
        expect(restored).toMatchObject({ outboxId: event!.outboxId, activityId, attemptCount: 0 });
        const claimed = restarted.claimCompletionOutbox(restored!.outboxId, SCOPE_A, "restarted-widget", 1_000, 4);
        expect(claimed).toMatchObject({ leaseOwner: "restarted-widget", attemptCount: 1 });
        restarted.markCompletionOutboxDelivered(restored!.outboxId, SCOPE_A, "restarted-widget", 5);
      } finally {
        restarted.close();
      }

      const verified = new BridgeStateStore({ file });
      try {
        expect(verified.listPendingCompletionOutbox(SCOPE_A)).toEqual([]);
        expect(verified.listCompletionOutbox(activityId)).toMatchObject([
          { outboxId: event!.outboxId, deliveredAt: 5, attemptCount: 1, leaseOwner: undefined }
        ]);
      } finally {
        verified.close();
      }
    } finally {
      try { first.close(); } catch {}
    }
  });

  it("leases one exact Job completion and records rejection, acceptance, and a result offer", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const jobId = "14141414-1414-4414-8414-141414141414";
    const requestId = "15151515-1515-4515-8515-151515151515";
    const firstOwner = "16161616-1616-4616-8616-161616161616";
    const secondOwner = "17171717-1717-4717-8717-171717171717";
    try {
      store.upsertJob({ ...job(jobId, requestId), status: "running", updatedAt: 1 });
      expect(store.getJobCompletionDelivery(jobId, SCOPE_A)).toBeUndefined();

      store.upsertJob({ ...job(jobId, requestId), updatedAt: 2 });
      const pending = store.getJobCompletionDelivery(jobId, SCOPE_A)!;
      expect(pending).toMatchObject({
        jobId,
        scopeId: SCOPE_A,
        terminalVersion: 1,
        state: "pending",
        attemptCount: 0,
        receipt: expect.stringMatching(/^completion-[0-9a-f]{64}$/)
      });

      const claimed = store.claimJobCompletionDelivery(jobId, SCOPE_A, firstOwner, 1_000, 10)!;
      expect(claimed).toMatchObject({ state: "leased", attemptCount: 1, leaseOwner: firstOwner });
      expect(store.claimJobCompletionDelivery(jobId, SCOPE_A, secondOwner, 1_000, 11))
        .toBeUndefined();

      const rejected = store.markJobCompletionHostRejected({
        jobId,
        scopeId: SCOPE_A,
        receipt: pending.receipt,
        leaseOwner: firstOwner,
        error: "host busy",
        now: 20
      });
      expect(rejected).toMatchObject({
        state: "host-rejected",
        attemptCount: 1,
        nextAttemptAt: 5_020,
        lastHostError: "host busy"
      });
      expect(store.claimJobCompletionDelivery(jobId, SCOPE_A, secondOwner, 1_000, 5_019))
        .toBeUndefined();

      const retried = store.claimJobCompletionDelivery(jobId, SCOPE_A, secondOwner, 1_000, 5_020)!;
      expect(retried).toMatchObject({ state: "leased", attemptCount: 2, leaseOwner: secondOwner });
      const accepted = store.markJobCompletionHostAccepted({
        jobId,
        scopeId: SCOPE_A,
        receipt: pending.receipt,
        leaseOwner: secondOwner,
        now: 5_021
      });
      expect(accepted).toMatchObject({ state: "host-accepted", hostAcceptedAt: 5_021 });
      expect(store.retentionProtection(jobId, 5_021)).toContain("undelivered-chatgpt-result");

      expect(store.recordJobCompletionResultOffer({
        scopeId: SCOPE_A,
        source: "completion-receipt",
        receipt: pending.receipt,
        now: 5_022
      })).toMatchObject({
        state: "host-accepted",
        completionResultOfferedAt: 5_022,
        resultReadAt: undefined,
        resultReadSource: undefined
      });
      expect(store.retentionProtection(jobId, 5_022)).not.toContain("undelivered-chatgpt-result");
      expect(store.retentionProtection(jobId, 5_022, 6_000))
        .toContain("chatgpt-result-recovery");
      expect(store.retentionProtection(jobId, 11_022, 6_000))
        .not.toContain("chatgpt-result-recovery");
    } finally {
      store.close();
    }
  });

  it("bounds unresolved ChatGPT completion results by run-history retention", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const jobId = "34343434-3434-4434-8434-343434343434";
    const requestId = "35353535-3535-4535-8535-353535353535";
    const owner = "36363636-3636-4636-8636-363636363636";
    const terminalAt = 1_800_000_000_000;
    const day = 86_400_000;
    const recoveryMs = 6 * 60 * 60_000;
    try {
      store.writeSettings({ historyRetentionDays: 7 }, 0, terminalAt);
      store.upsertJob({ ...job(jobId, requestId), updatedAt: terminalAt });
      const delivery = store.getJobCompletionDelivery(jobId, SCOPE_A)!;

      expect(store.retentionProtection(jobId, terminalAt + 1, recoveryMs))
        .not.toContain("undelivered-chatgpt-result");
      store.claimJobCompletionDelivery(jobId, SCOPE_A, owner, 1_000, terminalAt + 1);
      store.markJobCompletionHostAccepted({
        jobId,
        scopeId: SCOPE_A,
        receipt: delivery.receipt,
        leaseOwner: owner,
        now: terminalAt + 2
      });
      expect(store.retentionProtection(jobId, terminalAt + 7 * day - 1, recoveryMs))
        .toContain("undelivered-chatgpt-result");
      expect(store.retentionProtection(jobId, terminalAt + 7 * day, recoveryMs))
        .not.toContain("undelivered-chatgpt-result");

      const offeredAt = terminalAt + 7 * day - 1_000;
      store.recordJobCompletionResultOffer({
        scopeId: SCOPE_A,
        source: "completion-receipt",
        receipt: delivery.receipt,
        now: offeredAt
      });
      expect(store.retentionProtection(jobId, terminalAt + 7 * day, recoveryMs))
        .toContain("chatgpt-result-recovery");
      expect(store.retentionProtection(jobId, offeredAt + recoveryMs, recoveryMs))
        .not.toContain("chatgpt-result-recovery");
    } finally {
      store.close();
    }
  });

  it("records direct result offers without consuming or stealing a delivery", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const pendingJobId = "24242424-2424-4424-8424-242424242424";
    const leasedJobId = "26262626-2626-4626-8626-262626262626";
    const rejectedJobId = "29292929-2929-4929-8929-292929292929";
    const unknownJobId = "31313131-3131-4131-8131-313131313131";
    const owner = "33333333-3333-4333-8333-333333333333";
    try {
      store.upsertJob(job(pendingJobId, "25252525-2525-4525-8525-252525252525"));
      expect(store.recordJobCompletionResultOffer({
        scopeId: SCOPE_A,
        source: "direct-job-query",
        jobId: pendingJobId,
        now: 10
      })).toMatchObject({
        state: "pending",
        directResultOfferedAt: 10,
        resultReadAt: undefined,
        resultReadSource: undefined,
        attemptCount: 0
      });
      expect(store.claimJobCompletionDelivery(pendingJobId, SCOPE_A, owner, 1_000, 11))
        .toMatchObject({ state: "leased", attemptCount: 1 });

      store.upsertJob(job(leasedJobId, "27272727-2727-4727-8727-272727272727"));
      const leased = store.claimJobCompletionDelivery(leasedJobId, SCOPE_A, owner, 1_000, 20)!;
      expect(store.recordJobCompletionResultOffer({
        scopeId: SCOPE_A,
        source: "direct-job-query",
        jobId: leasedJobId,
        now: 21
      })).toMatchObject({
        state: "leased",
        directResultOfferedAt: 21,
        resultReadSource: undefined
      });
      expect(store.markJobCompletionHostAccepted({
        jobId: leasedJobId,
        scopeId: SCOPE_A,
        receipt: leased.receipt,
        leaseOwner: owner,
        now: 22
      })).toMatchObject({ state: "host-accepted" });

      store.upsertJob(job(rejectedJobId, "30303030-3030-4030-8030-303030303030"));
      const rejected = store.claimJobCompletionDelivery(rejectedJobId, SCOPE_A, owner, 1_000, 30)!;
      store.markJobCompletionHostRejected({
        jobId: rejectedJobId,
        scopeId: SCOPE_A,
        receipt: rejected.receipt,
        leaseOwner: owner,
        now: 31
      });
      expect(store.recordJobCompletionResultOffer({
        scopeId: SCOPE_A,
        source: "direct-job-query",
        jobId: rejectedJobId,
        now: 32
      })).toMatchObject({
        state: "host-rejected",
        directResultOfferedAt: 32,
        resultReadSource: undefined
      });
      expect(store.retentionProtection(rejectedJobId, 32))
        .toContain("undelivered-chatgpt-result");

      store.upsertJob(job(unknownJobId, "32323232-3232-4232-8232-323232323232"));
      const unknown = store.claimJobCompletionDelivery(unknownJobId, SCOPE_A, owner, 1_000, 40)!;
      store.markJobCompletionAcceptanceUnknown({
        jobId: unknownJobId,
        scopeId: SCOPE_A,
        receipt: unknown.receipt,
        leaseOwner: owner,
        now: 41
      });
      expect(store.recordJobCompletionResultOffer({
        scopeId: SCOPE_A,
        source: "direct-job-query",
        jobId: unknownJobId,
        now: 42
      })).toMatchObject({
        state: "acceptance-unknown",
        directResultOfferedAt: 42,
        resultReadSource: undefined
      });
      expect(store.retentionProtection(unknownJobId, 42))
        .toContain("undelivered-chatgpt-result");
    } finally {
      store.close();
    }
  });

  it("keeps a direct-wait Job policy immutable and out of the live-card lease path across restart", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const jobId = "45454545-4545-4545-8545-454545454545";
    const requestId = "46464646-4646-4646-8646-464646464646";
    try {
      store.upsertJob({
        ...job(jobId, requestId),
        status: "running",
        updatedAt: 1,
        completionDeliveryPolicy: "direct-wait"
      });
      store.upsertJob({
        ...job(jobId, requestId),
        completionDeliveryPolicy: "direct-wait"
      });
      expect(store.listJobs()).toEqual([
        expect.objectContaining({ jobId, completionDeliveryPolicy: "direct-wait" })
      ]);
      expect(store.getJobCompletionDelivery(jobId, SCOPE_A)).toMatchObject({
        state: "pending",
        attemptCount: 0
      });
      expect(store.claimJobCompletionDelivery(
        jobId,
        SCOPE_A,
        "47474747-4747-4747-8747-474747474747"
      )).toBeUndefined();
      expect(() => store.upsertJob({
        ...job(jobId, requestId),
        completionDeliveryPolicy: "live-card"
      })).toThrow(/completion delivery policy cannot change/);
      expect(store.listJobs()).toEqual([
        expect.objectContaining({ jobId, completionDeliveryPolicy: "direct-wait" })
      ]);
    } finally {
      store.close();
    }

    const restarted = new BridgeStateStore({ file });
    try {
      expect(restarted.listJobs()).toEqual([
        expect.objectContaining({ jobId, completionDeliveryPolicy: "direct-wait" })
      ]);
      expect(restarted.getJobCompletionDelivery(jobId, SCOPE_A)).toMatchObject({
        state: "pending",
        attemptCount: 0
      });
      expect(restarted.claimJobCompletionDelivery(
        jobId,
        SCOPE_A,
        "48484848-4848-4848-8848-484848484848"
      )).toBeUndefined();
      restarted.upsertJob({
        ...job(jobId, requestId),
        completionDeliveryPolicy: "direct-wait"
      });
      expect(restarted.listJobs()).toHaveLength(1);
      expect(() => restarted.upsertJob({
        ...job(jobId, requestId),
        completionDeliveryPolicy: "live-card"
      })).toThrow(/completion delivery policy cannot change/);
    } finally {
      restarted.close();
    }
  });

  it("turns an expired completion send lease into uncertainty without replay", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const jobId = "18181818-1818-4818-8818-181818181818";
    const requestId = "19191919-1919-4919-8919-191919191919";
    const firstOwner = "20202020-2020-4020-8020-202020202020";
    const secondOwner = "21212121-2121-4121-8121-212121212121";
    try {
      store.upsertJob(job(jobId, requestId));
      const delivery = store.getJobCompletionDelivery(jobId, SCOPE_A)!;
      expect(store.claimJobCompletionDelivery(jobId, SCOPE_A, firstOwner, 1_000, 10))
        .toMatchObject({ state: "leased" });
      expect(store.claimJobCompletionDelivery(jobId, SCOPE_A, secondOwner, 1_000, 1_010))
        .toBeUndefined();
      expect(store.getJobCompletionDeliveryByReceipt(delivery.receipt, SCOPE_A)).toMatchObject({
        state: "acceptance-unknown",
        acceptanceUnknownAt: 1_010,
        leaseOwner: undefined
      });
      expect(store.claimJobCompletionDelivery(jobId, SCOPE_A, secondOwner, 1_000, 10_000))
        .toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("finds retained status-card work and filters archived jobs before applying its limit", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const otherScope = "22222222-2222-4222-8222-222222222222";
    try {
      expect(store.hasDashboardWork(SCOPE_A)).toBe(false);
      store.upsertJob({ ...job("older-here", "request-here"), updatedAt: 10 });
      store.upsertJob({ ...job("newer-elsewhere", "request-elsewhere"), scopeId: otherScope, updatedAt: 20 });
      store.deleteJob("older-here");
      store.deleteJob("newer-elsewhere");
      expect(store.countJobs()).toBe(0);
      expect(store.hasDashboardWork(SCOPE_A)).toBe(true);
      expect(store.listDashboardRetainedJobs(1).map(job => job.jobId)).toEqual(["newer-elsewhere"]);
      expect(store.listDashboardRetainedJobs(1, SCOPE_A).map(job => job.jobId)).toEqual(["older-here"]);
    } finally { store.close(); }
  });

  it("commits session and job changes atomically and keeps the database private", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });

    expect(() =>
      store.transaction(() => {
        store.upsertSession(session("thread-rollback"));
        store.upsertJob(job("job-rollback", "request-rollback"));
        throw new Error("force rollback");
      })
    ).toThrow(/force rollback/);
    expect(store.countSessions()).toBe(0);
    expect(store.countJobs()).toBe(0);

    store.transaction(() => {
      store.upsertSession(session("thread-committed"));
      store.upsertJob(job("job-committed", "request-committed"));
    });
    expect(store.countSessions(SCOPE_A)).toBe(1);
    expect(store.countJobs(SCOPE_A, "completed")).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${file}-shm`).mode & 0o777).toBe(0o600);
    store.close();

    const reopened = new BridgeStateStore({ file });
    expect(reopened.listSessions()).toEqual([
      expect.objectContaining(session("thread-committed"))
    ]);
    expect(reopened.listJobs()).toEqual([
      expect.objectContaining({
        ...job("job-committed", "request-committed"),
        activityId: expect.any(String),
        backendKind: "mcp-server",
        terminalVersion: 1
      })
    ]);
    reopened.close();
  });

  it("rejects an unknown future schema instead of overwriting its version", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    store.setMeta("schema_version", "999");
    store.close();

    expect(() => new BridgeStateStore({ file })).toThrow(/Unsupported bridge state database schema version: 999/);
  });

  it("persists steering intent and dispatch state without storing the raw prompt", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const requestId = "12121212-1212-4212-8212-121212121212";
    const actionHash = "a".repeat(64);
    const rawPrompt = "private steering prompt must never enter SQLite";
    const promptSha256 = createHash("sha256").update(rawPrompt).digest("hex");
    const prepared = store.beginSteeringDelivery({
      scopeId: SCOPE_A,
      requestId,
      actionHash,
      jobId: "steering-job",
      expectedJobVersion: 7,
      promptSha256,
      now: 10
    });
    expect(prepared).toMatchObject({
      status: "prepared",
      promptSha256,
      result: undefined
    });
    expect(JSON.stringify(prepared)).not.toContain(rawPrompt);

    const dispatching = store.markSteeringDeliveryDispatching(
      SCOPE_A,
      requestId,
      actionHash,
      11
    );
    expect(dispatching).toMatchObject({ status: "dispatching", dispatchedAt: 11 });
    const result = {
      ok: true,
      action: "steer",
      delivery: { status: "delivered" },
      promptPersistedByBridge: false
    };
    store.completeSteeringDelivery(
      SCOPE_A,
      requestId,
      actionHash,
      "delivered",
      result,
      12
    );
    expect(store.getSteeringDelivery(SCOPE_A, requestId)).toMatchObject({
      status: "delivered",
      result,
      completedAt: 12
    });
    expect(() => store.beginSteeringDelivery({
      scopeId: SCOPE_A,
      requestId,
      actionHash: "c".repeat(64),
      jobId: "different-job",
      expectedJobVersion: 1,
      promptSha256: "d".repeat(64)
    })).toThrow(/STEERING_REQUEST_CONFLICT/);
    store.close();
    expect(readFileSync(file).includes(Buffer.from(rawPrompt))).toBe(false);

    const reopened = new BridgeStateStore({ file });
    expect(reopened.schemaVersion).toBe(31);
    expect(reopened.listSteeringDeliveries(SCOPE_A)).toEqual([
      expect.objectContaining({
        requestId,
        actionHash,
        promptSha256,
        status: "delivered",
        result
      })
    ]);
    reopened.close();
  });

  it("persists first-class project admission without exposing the canonical path on Activities", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const cwd = temporaryRoot();
    const project = registerProject(store, "Codex MCP Bridge", cwd);
    const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    store.createActivity({
      activityId,
      scopeId: SCOPE_A,
      projectId: project.id,
      projectName: project.name,
      projectCwd: cwd,
      title: "Project-aware work",
      now: 1
    });
    store.upsertSession({
      ...session("thread-project"),
      cwd,
      projectId: project.id,
      projectName: project.name
    });
    store.upsertJob({
      ...job("job-project", "request-project"),
      activityId,
      cwd,
      projectId: project.id,
      projectName: project.name
    });

    expect(store.getActivity(activityId)).toMatchObject({
      projectId: project.id,
      projectName: "Codex MCP Bridge"
    });
    expect(store.getActivity(activityId)).not.toHaveProperty("projectCwd");
    expect(store.getActivityProjectAdmission(activityId)).toEqual({
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      projectCwd: cwd
    });
    expect(store.listSessions()).toEqual([
      expect.objectContaining({ projectId: project.id, projectName: "Codex MCP Bridge" })
    ]);
    expect(store.listJobs()).toEqual([
      expect.objectContaining({ projectId: project.id, projectName: "Codex MCP Bridge" })
    ]);
    expect(() => store.upsertJob({
      ...job("job-project", "request-project"),
      activityId,
      cwd,
      projectId: "22222222-2222-4222-8222-222222222222",
      projectName: "Other"
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.schemaVersion).toBe(31);
    expect(restored.getActivityProjectAdmission(activityId)?.projectId).toBe(project.id);
    expect(restored.listJobs()).toEqual([
      expect.objectContaining({ projectId: project.id, projectName: "Codex MCP Bridge" })
    ]);
    restored.close();
  });

  it("inherits a continuation project by default but permits an explicit fresh-project admission", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const alphaCwd = temporaryRoot();
    const betaCwd = temporaryRoot();
    const alpha = registerProject(store, "Alpha", alphaCwd);
    const beta = registerProject(store, "Beta", betaCwd);
    const sourceId = "abababab-abab-4bab-8bab-abababababab";
    const inheritedId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
    const switchedId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    store.createActivity({
      activityId: sourceId,
      scopeId: SCOPE_A,
      projectId: alpha.id,
      projectName: "Alpha",
      projectCwd: alphaCwd,
      now: 1
    });

    store.createActivity({
      activityId: inheritedId,
      scopeId: SCOPE_A,
      continuationOfActivityId: sourceId,
      now: 2
    });
    store.createActivity({
      activityId: switchedId,
      scopeId: SCOPE_A,
      continuationOfActivityId: sourceId,
      projectId: beta.id,
      projectName: "Beta",
      projectCwd: betaCwd,
      now: 3
    });

    expect(store.getActivityProjectAdmission(inheritedId)).toMatchObject({
      projectId: alpha.id,
      projectCwd: alphaCwd
    });
    expect(store.getActivityProjectAdmission(switchedId)).toMatchObject({
      projectId: beta.id,
      projectCwd: betaCwd
    });
    store.close();
  });

  it("backfills a legacy Activity only when every admitted job uses the selected project folder", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const cwd = temporaryRoot();
    const otherCwd = temporaryRoot();
    const project = registerProject(store, "Codex MCP Bridge", cwd);
    const compatibleActivity = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    store.createActivity({ activityId: compatibleActivity, scopeId: SCOPE_A, now: 1 });
    store.upsertJob({
      ...job("legacy-job", "legacy-request"),
      activityId: compatibleActivity,
      cwd
    });
    store.upsertJob({
      ...job("project-job", "project-request"),
      activityId: compatibleActivity,
      cwd,
      projectId: project.id,
      projectName: "Codex MCP Bridge"
    });
    expect(store.getActivityProjectAdmission(compatibleActivity)?.projectId).toBe(project.id);

    const ambiguousActivity = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    store.createActivity({ activityId: ambiguousActivity, scopeId: SCOPE_A, now: 3 });
    store.upsertJob({
      ...job("other-legacy-job", "other-legacy-request"),
      activityId: ambiguousActivity,
      cwd: otherCwd
    });
    expect(() => store.upsertJob({
      ...job("other-project-job", "other-project-request"),
      activityId: ambiguousActivity,
      cwd,
      projectId: project.id,
      projectName: "Codex MCP Bridge"
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    expect(store.getActivityProjectAdmission(ambiguousActivity)).toBeUndefined();
    store.close();
  });

  it("persists first-class cancellation provenance before permitting a cancelled job", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const activityId = "dededede-dede-4ede-8ede-dededededede";
    const requestId = "efefefef-efef-4fef-8fef-efefefefefef";
    const callerPresentationId = "abababab-abab-4aba-8aba-abababababab";
    const targetPresentationId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
    const activeJob = {
      ...job("durable-cancel-job", "durable-job-request"),
      activityId,
      status: "running",
      updatedAt: 2,
      activityPresentationId: targetPresentationId
    };
    store.createActivity({ activityId, scopeId: SCOPE_A, now: 1 });
    store.upsertJob(activeJob);

    expect(() => store.upsertJob({
      ...activeJob,
      status: "cancelled",
      terminalOrigin: "explicit-cancellation",
      updatedAt: 3
    })).toThrow(/CANCELLATION_PROVENANCE_REQUIRED/);
    expect(() => store.upsertJob({
      ...activeJob,
      status: "cancelled",
      terminalOrigin: "legacy-unattributed-cancellation",
      updatedAt: 3
    })).toThrow(/CANCELLATION_PROVENANCE_REQUIRED/);
    expect(store.listJobs()).toEqual([
      expect.objectContaining({ status: "running" })
    ]);
    expect(store.listJobs()[0]).not.toHaveProperty("cancellationIntentId");

    const { operation, intent } = store.beginCancellationOperation({
      scopeId: SCOPE_A,
      requestId,
      actionHash: "f".repeat(64),
      source: "widget-control",
      toolName: "codex_cancel",
      actionName: "cancel-dashboard-job",
      target: {
        kind: "job",
        jobId: activeJob.jobId,
        activityId,
        presentationId: targetPresentationId
      },
      expectedVersion: 1,
      callerPresentation: {
        kind: "automatic",
        activityPresentationId: callerPresentationId
      },
      widgetProof: {
        instanceDigest: "1".repeat(64),
        cardGeneration: 7
      },
      callerRequestDigest: "2".repeat(64),
      reasonCode: "dashboard-force-stop",
      now: 4
    });
    expect(operation.rootIntentId).toBe(intent.intentId);
    expect(operation.bridgeInstanceId).toBe(store.bridgeInstanceId);
    store.setCancellationIntentStatus(intent.intentId, "dispatched", 5);
    store.upsertJob({
      ...activeJob,
      status: "cancelled",
      terminalOrigin: "explicit-cancellation",
      cancellationIntentId: intent.intentId,
      updatedAt: 6
    });
    store.setCancellationIntentStatus(intent.intentId, "succeeded", 7);
    store.completeCancellationOperation(SCOPE_A, requestId, { status: "cancelled" }, "completed", 8);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.getCancellationOperation(SCOPE_A, requestId)).toMatchObject({
      status: "completed",
      source: "widget-control",
      bridgeInstanceId: expect.any(String),
      targetJobId: activeJob.jobId,
      targetPresentationId,
      result: { status: "cancelled" }
    });
    expect(restored.getCancellationIntent(intent.intentId)).toMatchObject({
      requestId,
      status: "succeeded",
      callerPresentation: {
        kind: "automatic",
        activityPresentationId: callerPresentationId
      },
      targetPresentationId,
      widgetInstancePresent: true,
      widgetInstanceDigest: "1".repeat(64),
      cardGeneration: 7,
      callerRequestDigest: "2".repeat(64)
    });
    expect(restored.listJobs()).toEqual([
      expect.objectContaining({
        status: "cancelled",
        terminalOrigin: "explicit-cancellation",
        cancellationIntentId: intent.intentId
      })
    ]);
    restored.close();
  });

  it("persists a bounded user-facing model cancellation reason in the durable root operation", () => {
    const file = stateFile();
    const store = new BridgeStateStore({ file });
    const activityId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const requestId = "cececece-cece-4ece-8ece-cececececece";
    const activeJob = {
      ...job("reasoned-cancel-job", "reasoned-job-request"),
      activityId,
      status: "running",
      updatedAt: 2
    };
    store.createActivity({ activityId, scopeId: SCOPE_A, now: 1 });
    store.upsertJob(activeJob);

    const { intent } = store.beginCancellationOperation({
      scopeId: SCOPE_A,
      requestId,
      actionHash: "e".repeat(64),
      source: "model-tool",
      toolName: "codex_cancel",
      actionName: "cancel-job",
      target: { kind: "job", jobId: activeJob.jobId, activityId },
      expectedVersion: 1,
      reasonCode: "public-job-cancel",
      reason: "  The user changed direction.\nStop the obsolete job.  ",
      now: 3
    });
    expect(store.getCancellationOperation(SCOPE_A, requestId)?.reason).toBe(
      "The user changed direction. Stop the obsolete job."
    );
    expect(store.listJobEvents(activeJob.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "cancellation-intent-recorded",
        payload: expect.objectContaining({
          cancellationIntentId: intent.intentId,
          reason: "The user changed direction. Stop the obsolete job."
        })
      })
    ]));
    expect(() => store.beginCancellationOperation({
      scopeId: SCOPE_A,
      requestId: "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf",
      actionHash: "d".repeat(64),
      source: "model-tool",
      toolName: "codex_cancel",
      actionName: "cancel-job",
      target: { kind: "job", jobId: activeJob.jobId, activityId },
      expectedVersion: 1,
      reasonCode: "public-job-cancel",
      reason: "x".repeat(501),
      now: 4
    })).toThrow(/500 characters/);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.schemaVersion).toBe(31);
    expect(restored.getCancellationOperation(SCOPE_A, requestId)).toMatchObject({
      source: "model-tool",
      reason: "The user changed direction. Stop the obsolete job."
    });
    restored.close();
  });


});

const SCOPE_A = "11111111-1111-4111-8111-111111111111";

function stateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "bridge-sqlite-state-")), "private", "state.sqlite");
}

function temporaryRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "bridge-state-project-")));
}

function registerProject(store: BridgeStateStore, name: string, cwd: string) {
  const before = store.getProjectRegistryRevision();
  return store.applyProjectOperations(
    [{ kind: "add", project: { name, cwd } }],
    before,
    []
  ).projects.at(-1)!;
}

function session(threadId: string) {
  return {
    threadId,
    scopeId: SCOPE_A,
    cwd: "/tmp/repository",
    lastUsedAt: 1
  };
}

function job(jobId: string, requestId: string) {
  return {
    jobId,
    scopeId: SCOPE_A,
    requestId,
    status: "completed",
    updatedAt: 2
  };
}
