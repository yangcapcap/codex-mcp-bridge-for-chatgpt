import { COGATE_UNIFIED_SCHEMA_TABLES } from "../src/cogateUnifiedSchema.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { SessionRegistry } from "../src/sessionRegistry.js";
import { createMigrationBackupMetadata } from "../src/stateBackup.js";
import {
  CURRENT_STATE_SCHEMA,
  V20_ASYNC_EXECUTION_MIGRATION_SCHEMA,
  V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA
} from "../src/stateSchema.js";
import {
  V18_ACTIVITY_ID,
  V18_AGENT_ID,
  V18_FAILED_JOB_ID,
  V18_LEGACY_ACTIVITY_ID,
  V18_LEGACY_AGENT_ID,
  V18_LEGACY_JOB_ID,
  V18_LEGACY_THREAD_ID,
  V18_PROJECT_ID,
  V18_RUNNING_JOB_ID,
  V18_SCOPE_ID,
  V18_THREAD_ID,
  createSchema18Fixture,
  createSeededSchema3Fixture
} from "./helpers/stateSchemaFixtures.js";

describe("current state schema after asynchronous-execution normalization", { timeout: 15_000 }, () => {
  it("keeps schema-29 sessions without owner evidence quarantined after the upgrade", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-v29-session-owner-"));
    const file = path.join(root, "state.sqlite");
    let store = new BridgeStateStore({ file });
    const scopeId = "11111111-1111-4111-8111-111111111111";
    const now = Date.now();
    store.upsertSession({ threadId: "legacy-thread", scopeId, backendKind: "app-server",
      cwd: root, sandbox: "read-only", createdAt: now, updatedAt: now, lastUsedAt: now });
    store.close();
    const prior = new Database(file);
    for (const table of [...COGATE_UNIFIED_SCHEMA_TABLES].reverse()) {
      prior.exec(`DROP TABLE ${table}`);
    }
    prior.exec("ALTER TABLE sessions DROP COLUMN auth_boundary");
    prior.prepare("UPDATE bridge_meta SET value='29' WHERE key='schema_version'").run();
    prior.prepare("DELETE FROM bridge_meta WHERE key='schema_v30_created_at'").run();
    prior.close();
    store = new BridgeStateStore({ file });
    const boundary = { key: "a".repeat(64), allowLegacyShared: false };
    expect(store.listSessions()).toMatchObject([{ threadId: "legacy-thread" }]);
    const registry = new SessionRegistry({ stateStore: store, authBoundary: boundary });
    expect(registry.get("legacy-thread")).toBeUndefined();
    expect(registry.belongsToAnotherAuthentication("legacy-thread")).toBe(true);
    registry.record({ threadId: "owned-thread", scopeId, backendKind: "app-server", cwd: root,
      sandbox: "read-only", createdAt: now, updatedAt: now, lastUsedAt: now });
    store.close();
    const reopened = new BridgeStateStore({ file });
    try {
      const restored = new SessionRegistry({ stateStore: reopened, authBoundary: boundary });
      expect(restored.get("legacy-thread")).toBeUndefined();
      expect(restored.get("owned-thread")?.authBoundary).toBe(boundary.key);
      expect(reopened.countSessions()).toBe(2);
    } finally { reopened.close(); }
  });

  it("upgrades a schema-28 state while retaining exact Job and blocked recovery authority", () => {
    const root = mkdtempSync(path.join(tmpdir(),"bridge-schema-v28-background-"));
    const file = path.join(root,"state.sqlite");
    let store = new BridgeStateStore({file});
    const scopeId = "11111111-1111-4111-8111-111111111111";
    const jobId = "22222222-2222-4222-8222-222222222222";
    const agent = store.createAgent({scopeId,agentName:"Preserved recovery owner"});
    store.upsertJob({jobId,scopeId,requestId:"issue-193-preserved-request",
      agentId:agent.agentId,status:"failed",updatedAt:1_000});
    const candidate = {key:"issue-193-preserved-incident",scopeId,agentId:agent.agentId,
      jobId,kind:"recheck" as const};
    store.automaticRecovery.begin(candidate,1_000);
    store.automaticRecovery.finish(candidate.key,1,
      {resolved:false,reason:"inspection-unconfirmed",retryable:false},1_001);
    store.close();
    // Construct a schema-28 fixture from the current database while retaining
    // the same domain rows.
    const prior = new Database(file);
    for (const name of ["automatic_recovery_agent_state","automatic_recovery_interrupted",
      "automatic_recovery_due","automatic_recovery_retention","automatic_recovery_incident_retention",
      "jobs_history_retention","thread_connections_worker","thread_connections_handoff",
      "thread_connections_release_due"]) prior.exec(`DROP INDEX ${name}`);
    for (const table of [...COGATE_UNIFIED_SCHEMA_TABLES].reverse()) {
      prior.exec(`DROP TABLE ${table}`);
    }
    prior.exec("ALTER TABLE sessions DROP COLUMN auth_boundary");
    prior.prepare("UPDATE bridge_meta SET value='28' WHERE key='schema_version'").run();
    prior.prepare("DELETE FROM bridge_meta WHERE key='schema_v29_created_at'").run();
    prior.close();
    store = new BridgeStateStore({file});
    expect(store.schemaVersion).toBe(31);
    expect(store.statusReadModel.job(jobId)).toMatchObject({jobId,status:"failed"});
    expect(store.automaticRecovery.get(candidate.key)).toMatchObject({state:"blocked",attempts:1});
    expect(existsSync(`${file}.pre-v28-to-v31.sqlite`)).toBe(true);
    store.close();
  });

  it("uses the Agent history index on fresh and upgraded state without changing latest Job identity", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-agent-history-"));
    const upgradedFile = path.join(root, "upgraded.sqlite");
    createSchema18Fixture(upgradedFile);
    expect(() => new BridgeStateStore({
      file: upgradedFile,
      onMigrationProgress(progress) {
        if (progress.targetSchema === 27) throw new Error("schema-27-checkpoint");
      }
    })).toThrow("schema-27-checkpoint");
    const query = `SELECT job_id FROM jobs j WHERE agent_id=?
      AND NOT EXISTS (SELECT 1 FROM work_history_state h
        WHERE h.job_id=j.job_id AND h.expired_at IS NOT NULL)
      ORDER BY created_at DESC,updated_at DESC,job_id DESC LIMIT 1`;
    const before = new Database(upgradedFile, { readonly: true });
    const expected = before.prepare(query).get(V18_AGENT_ID) as { job_id: string } | undefined;
    before.close();

    const upgraded = new BridgeStateStore({ file: upgradedFile });
    expect(upgraded.workHistory.latestJob(V18_AGENT_ID)?.jobId).toBe(expected?.job_id);
    upgraded.close();
    const freshFile = path.join(root, "fresh.sqlite");
    new BridgeStateStore({ file: freshFile }).close();
    for (const file of [freshFile, upgradedFile]) {
      const database = new Database(file, { readonly: true });
      const details = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(V18_AGENT_ID)
        .map(row => String((row as { detail: string }).detail));
      expect(details).toContainEqual(expect.stringContaining("jobs_agent_recent_history"));
      database.close();
    }
  });

  it("upgrades schema 19 without losing request dedupe identity or terminal results", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-v19-async-"));
    const file = path.join(root, "state.sqlite");
    const scopeId = "19191919-1919-4919-8919-191919191919";
    const activityId = "20202020-2020-4020-8020-202020202020";
    const jobId = "21212121-2121-4121-8121-212121212121";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const requestHash = "a".repeat(64);
    const database = new Database(file);
    database.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;");
    database.exec(CURRENT_STATE_SCHEMA);
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_version','19')").run();
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_database_id',?)")
      .run("23232323-2323-4323-8323-232323232323");
    database.prepare("INSERT INTO scopes(scope_id,version,created_at,updated_at) VALUES (?,?,?,?)")
      .run(scopeId, 2, 1, 2);
    database.prepare(`INSERT INTO activities(
      activity_id,scope_id,title,kind,execution_mode,handoff_policy,completion_trigger,
      lifecycle,waiting_on,verification,version,created_at,updated_at,total_jobs,
      completed_jobs,terminal_jobs
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      activityId, scopeId, "Schema 19 task", "implementation", "foreground", "none", "manual",
      "open", "orchestrator", "not-required", 2, 1, 2, 1, 1, 1
    );
    database.prepare(`INSERT INTO jobs(
      job_id,scope_id,request_id,activity_id,status,execution_mode,backend_kind,cwd,sandbox,
      created_at,updated_at,job_version,last_progress_at,terminal_origin,terminal_version,summary,payload
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      jobId, scopeId, requestId, activityId, "completed", "foreground", "mcp-server", root,
      "workspace-write", 1, 2, 2, 2, "normal-completion", 1, "{}", JSON.stringify({
        jobId,
        scopeId,
        requestId,
        requestHash,
        requestHashVersion: 11,
        activityId,
        status: "completed",
        executionMode: "foreground",
        backendKind: "mcp-server",
        operation: "start",
        cwd: root,
        sandbox: "workspace-write",
        createdAt: 1,
        updatedAt: 2,
        version: 2,
        lastProgressAt: 2,
        exclusiveKeys: [],
        sessionDecision: { requestedMode: "new", action: "start", reason: "explicit-new" },
        result: { content: [{ type: "text", text: "retained schema 19 result" }] }
      })
    );
    database.close();

    const store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(31);
    const [restored] = store.listJobs() as Array<Record<string, unknown>>;
    expect(restored).toMatchObject({
      jobId,
      requestId,
      requestHash,
      requestHashVersion: 11,
      status: "completed",
      result: { content: [{ type: "text", text: "retained schema 19 result" }] }
    });
    expect(restored).not.toHaveProperty("executionMode");
    expect(store.getActivity(activityId)).not.toHaveProperty("executionMode");
    expect(store.getJobCompletionDelivery(jobId, scopeId)).toBeUndefined();
    expect(() => store.upsertJob({
      ...(restored as any),
      jobId: "24242424-2424-4424-8424-242424242424"
    })).toThrow(/requestId was already used by another Codex job/);
    store.close();

    const current = new Database(file, { readonly: true });
    expect(current.prepare("PRAGMA table_info(activities)").all())
      .not.toContainEqual(expect.objectContaining({ name: "execution_mode" }));
    expect(current.prepare("PRAGMA table_info(jobs)").all())
      .not.toContainEqual(expect.objectContaining({ name: "execution_mode" }));
    current.close();
    expect(existsSync(`${file}.pre-v19-to-v31.sqlite`)).toBe(true);
  });

  it("backfills schema 21 receipt consumption without replaying a terminal Job", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-v21-consumption-"));
    const file = path.join(root, "state.sqlite");
    const scopeId = "34343434-3434-4434-8434-343434343434";
    const activityId = "35353535-3535-4535-8535-353535353535";
    const jobId = "36363636-3636-4636-8636-363636363636";
    const requestId = "37373737-3737-4737-8737-373737373737";
    const receipt = `completion-${"d".repeat(64)}`;
    const database = new Database(file);
    database.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;");
    database.exec(CURRENT_STATE_SCHEMA);
    database.exec(V20_ASYNC_EXECUTION_MIGRATION_SCHEMA);
    database.exec(V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA);
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_version','21')").run();
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_database_id',?)")
      .run("38383838-3838-4838-8838-383838383838");
    database.prepare("INSERT INTO scopes(scope_id,version,created_at,updated_at) VALUES (?,?,?,?)")
      .run(scopeId, 1, 1, 2);
    database.prepare(`INSERT INTO activities(
      activity_id,scope_id,title,kind,handoff_policy,completion_trigger,lifecycle,
      waiting_on,verification,version,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      activityId, scopeId, "Schema 21 completion", "implementation", "none", "manual",
      "open", "orchestrator", "not-required", 1, 1, 2
    );
    database.prepare(`INSERT INTO jobs(
      job_id,scope_id,request_id,activity_id,status,backend_kind,terminal_version,cwd,
      sandbox,created_at,updated_at,job_version,last_progress_at,terminal_origin,payload
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      jobId, scopeId, requestId, activityId, "completed", "mcp-server", 1, root,
      "workspace-write", 1, 2, 2, 2, "normal-completion", JSON.stringify({
        jobId,
        scopeId,
        requestId,
        activityId,
        status: "completed",
        backendKind: "mcp-server",
        cwd: root,
        sandbox: "workspace-write",
        createdAt: 1,
        updatedAt: 2,
        version: 2,
        lastProgressAt: 2,
        exclusiveKeys: [],
        sessionDecision: { requestedMode: "new", action: "start", reason: "explicit-new" },
        result: { content: [{ type: "text", text: "schema 21 result" }] }
      })
    );
    database.prepare(`INSERT INTO job_completion_deliveries(
      job_id,scope_id,terminal_version,receipt,state,attempt_count,result_read_at,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,0,?,?,?)`).run(
      jobId, scopeId, 1, receipt, "result-read", 2, 2, 2
    );
    database.close();

    const store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(31);
    expect(store.getJobCompletionDelivery(jobId, scopeId)).toMatchObject({
      state: "result-read",
      resultReadSource: "completion-receipt",
      completionResultOfferedAt: 2,
      directResultOfferedAt: undefined,
      attemptCount: 0
    });
    expect(store.getJobCompletionDelivery(jobId, scopeId)?.createdAt).toBe(2);
    store.close();
    expect(existsSync(`${file}.pre-v21-to-v31.sqlite`)).toBe(true);
  });

  it("creates the current schema directly and matches an authentic schema 18 upgrade", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-v19-"));
    const originalCwd = path.join(root, "original-project");
    const relocatedCwd = path.join(root, "relocated-project");
    const legacyCwd = path.join(root, "legacy-project");
    mkdirSync(originalCwd);
    mkdirSync(relocatedCwd);
    mkdirSync(legacyCwd);

    const freshFile = path.join(root, "fresh.sqlite");
    const fresh = new BridgeStateStore({ file: freshFile });
    expect(fresh.schemaVersion).toBe(31);
    fresh.close();

    const upgradedFile = path.join(root, "upgraded.sqlite");
    createSchema18Fixture(upgradedFile, { projectCwd: originalCwd, legacyCwd });
    let upgraded = new BridgeStateStore({ file: upgradedFile });
    expect(upgraded.schemaVersion).toBe(31);
    expect(upgraded.getMeta("schema_v19_source_version")).toBe("18");
    expect(upgraded.getMeta("schema_v19_upgrade_source")).toBeUndefined();
    expect(schemaInventory(upgradedFile)).toEqual(schemaInventory(freshFile));
    expect(upgraded.getScopeVersion(V18_SCOPE_ID)).toBe(12);

    const backup = `${upgradedFile}.pre-v18-to-v31.sqlite`;
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(readSchemaVersion(backup)).toBe(18);
    expect(readdirSync(root).filter((name) => name.includes("pre-v18-to-v31"))).toHaveLength(1);

    expect(upgraded.listSessions()).toEqual([
      expect.objectContaining({
        threadId: V18_THREAD_ID,
        projectId: V18_PROJECT_ID,
        projectName: "Schema 18 Project",
        cwd: originalCwd,
        sandbox: "danger-full-access",
        persistence: "persistent",
        sessionId: "session-v18"
      })
    ]);
    expect(upgraded.getActivity(V18_ACTIVITY_ID)).toMatchObject({
      projectId: V18_PROJECT_ID,
      projectName: "Schema 18 Project"
    });
    expect(upgraded.getActivity(V18_LEGACY_ACTIVITY_ID)).toMatchObject({
      projectId: undefined,
      projectName: undefined
    });
    expect(upgraded.getActivityProjectAdmission(V18_ACTIVITY_ID)).toEqual({
      projectId: V18_PROJECT_ID,
      projectName: "Schema 18 Project",
      projectCwd: originalCwd
    });
    expect(upgraded.listAgentThreads(V18_AGENT_ID)).toEqual([
      expect.objectContaining({
        threadId: V18_THREAD_ID,
        projectId: V18_PROJECT_ID,
        projectName: "Schema 18 Project",
        cwd: originalCwd,
        sandbox: "danger-full-access"
      })
    ]);
    expect(upgraded.listAgentThreads(V18_LEGACY_AGENT_ID)).toEqual([]);
    expect(upgraded.getAgent(V18_LEGACY_AGENT_ID)).toMatchObject({
      lifecycle: "orphaned",
      currentThreadId: undefined,
      currentJobId: undefined,
      orphanedReason: "legacy-project-context-removed"
    });

    const active = upgraded.listJobs() as Array<Record<string, unknown>>;
    expect(active).toEqual([
      expect.objectContaining({
        jobId: V18_RUNNING_JOB_ID,
        sourceThreadId: "source-thread-v18",
        projectId: V18_PROJECT_ID,
        projectName: "Schema 18 Project",
        cwd: originalCwd,
        sandbox: "danger-full-access",
        version: 4,
        pendingInteractions: [expect.objectContaining({ interactionId: "question-v18", isBlocking: true })]
      })
    ]);
    expect(upgraded.workHistory.acknowledgedJobIds().has(V18_FAILED_JOB_ID)).toBe(true);
    expect(upgraded.eventRetention.summary(V18_FAILED_JOB_ID)).toEqual({
      execution: { model: "fixture-model", reasoningEffort: "high" },
      usage: { basis: "cumulative-difference", tokens: { inputTokens: 10, outputTokens: 2 } },
      uncertainResponseReview: { count: 1, latestUpdateAt: 71, reviewedAt: 72 }
    });
    expect(upgraded.workHistory.reviewRevision()).toBe(7);
    expect(upgraded.workHistory.runtimeResolution(V18_AGENT_ID, "runtime-revision")).toBe(55);
    expect(upgraded.workHistory.policy(30)).toMatchObject({
      lastCleanupAt: new Date(60).toISOString(),
      lastCleanupCount: 2,
      totalRemoved: 9
    });
    expect(upgraded.automaticRecovery.get("recovery-v18")).toMatchObject({
      state: "retrying",
      attempts: 1,
      jobId: V18_RUNNING_JOB_ID
    });

    const renamed = upgraded.applyProjectOperations(
      [{ kind: "rename", projectId: V18_PROJECT_ID, name: "Current Project Name" }],
      3,
      [],
      100
    );
    expect(renamed.registryRevision).toBe(4);
    upgraded.applyProjectOperations(
      [{ kind: "relocate", projectId: V18_PROJECT_ID, cwd: relocatedCwd }],
      4,
      [],
      110
    );
    expect(upgraded.listSessions()).toEqual([
      expect.objectContaining({ projectName: "Current Project Name", cwd: originalCwd })
    ]);
    expect(upgraded.getActivityProjectAdmission(V18_ACTIVITY_ID)).toEqual({
      projectId: V18_PROJECT_ID,
      projectName: "Current Project Name",
      projectCwd: originalCwd
    });
    expect(upgraded.listAgentThreads(V18_AGENT_ID)).toEqual([
      expect.objectContaining({ projectName: "Current Project Name", cwd: originalCwd })
    ]);

    const db = new Database(upgradedFile, { readonly: true });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(tableCount(db, "sessions")).toBe(1);
    expect(tableCount(db, "agent_threads")).toBe(1);
    expect(tableCount(db, "jobs")).toBe(3);
    expect(tableCount(db, "job_interactions")).toBe(1);
    expect(tableCount(db, "completion_outbox")).toBe(1);
    expect(tableCount(db, "cancellation_operations")).toBe(1);
    expect(tableCount(db, "cancellation_intents")).toBe(1);
    expect(tableCount(db, "steering_deliveries")).toBe(1);
    expect(tableCount(db, "user_questions")).toBe(1);
    expect(tableCount(db, "automatic_recovery")).toBe(1);
    expect(tableCount(db, "runtime_problem_resolutions")).toBe(1);
    expect(db.prepare("SELECT cursor_event_id FROM event_retention_state WHERE singleton=1").get())
      .toEqual({ cursor_event_id: 1 });
    expect(db.prepare("SELECT review_sequence FROM work_history_state WHERE job_id=?").get(V18_FAILED_JOB_ID))
      .toEqual({ review_sequence: 6 });
    expect(db.prepare("SELECT project_id,pinned_cwd FROM activities WHERE activity_id=?").get(V18_LEGACY_ACTIVITY_ID))
      .toEqual({ project_id: null, pinned_cwd: null });
    expect(db.prepare("SELECT cwd FROM jobs WHERE job_id=?").get(V18_LEGACY_JOB_ID))
      .toEqual({ cwd: legacyCwd });
    expect(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE project_id='legacy-project-slug'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE thread_id=?").get(V18_LEGACY_THREAD_ID))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM cancellation_intents").get()).toEqual({ status: "dispatched" });
    expect(db.prepare("SELECT status FROM steering_deliveries").get()).toEqual({ status: "uncertain" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM bridge_meta WHERE key LIKE 'work_history_%' OR key LIKE 'runtime_problem_resolved:%' OR key LIKE 'event_retention_%'").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE
      json_type(payload,'$.projectId') IS NOT NULL OR
      json_type(payload,'$.projectLabel') IS NOT NULL OR
      json_type(payload,'$.projectName') IS NOT NULL OR
      json_type(payload,'$.cwd') IS NOT NULL OR
      json_type(payload,'$.pendingInteractions') IS NOT NULL`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM job_interactions WHERE
      json_type(payload,'$.interactionId') IS NOT NULL OR
      json_type(payload,'$.isBlocking') IS NOT NULL`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM jobs,json_each(jobs.summary) entry
      WHERE entry.key NOT IN ('execution','usage','uncertainResponseReview')`).get())
      .toEqual({ count: 0 });
    expect(deprecatedCurrentObjects(db)).toEqual([]);
    db.close();

    upgraded.close();
    upgraded = new BridgeStateStore({ file: upgradedFile });
    expect(upgraded.schemaVersion).toBe(31);
    upgraded.close();
    expect(readdirSync(root).filter((name) => name.includes("pre-v18-to-v31"))).toHaveLength(1);
  });

  it("upgrades the published schema 3 fixture through every supported checkpoint", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-v3-"));
    const file = path.join(root, "state.sqlite");
    createSeededSchema3Fixture(file);

    let store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(31);
    expect(store.getMeta("schema_v19_source_version")).toBe("3");
    expect(store.getMeta("schema_v19_upgrade_source")).toBeUndefined();
    expect(store.listSessions()).toEqual([
      expect.objectContaining({
        threadId: "v3-thread",
        scopeId: V18_SCOPE_ID,
        backendKind: "mcp-server",
        cwd: "/tmp/issue95-v3-project",
        sandbox: "workspace-write"
      })
    ]);
    expect(store.getActivity("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toMatchObject({
      title: "Published schema 3 activity"
    });
    expect(store.getActivity("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .not.toHaveProperty("executionMode");
    expect(store.listJobs()).toEqual([
      expect.objectContaining({
        jobId: "v3-job",
        requestId: "v3-request",
        status: "failed",
        error: "V3_FAILURE: retained failure"
      })
    ]);
    expect(existsSync(`${file}.pre-v3-to-v31.sqlite`)).toBe(true);
    expect(readSchemaVersion(`${file}.pre-v3-to-v31.sqlite`)).toBe(3);
    const firstInventory = schemaInventory(file);
    store.close();

    store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(31);
    store.close();
    expect(schemaInventory(file)).toEqual(firstInventory);
    expect(readdirSync(root).filter((name) => name.includes("pre-v3-to-v31"))).toHaveLength(1);
  });

  it.each([
    {
      name: "does not resurrect a rejected legacy session from a clean Agent mirror",
      threadId: V18_LEGACY_THREAD_ID,
      agentId: V18_LEGACY_AGENT_ID,
      mutate(db: Database.Database) {
        db.prepare(`UPDATE agent_threads SET
          project_id=NULL,project_label=NULL,project_uuid=NULL,
          project_name_snapshot=NULL,project_cwd_snapshot=NULL
          WHERE thread_id=?`).run(V18_LEGACY_THREAD_ID);
      },
      sessionRetained: false,
      relationRetained: false,
      lifecycle: "orphaned"
    },
    {
      name: "rejects an invalid Agent mirror beside a valid canonical session",
      threadId: V18_THREAD_ID,
      agentId: V18_AGENT_ID,
      mutate(db: Database.Database) {
        db.prepare(`UPDATE agent_threads SET
          project_id='legacy-project-slug',project_label='Legacy Project',
          project_uuid=NULL,project_name_snapshot='Legacy Project'
          WHERE thread_id=?`).run(V18_THREAD_ID);
      },
      sessionRetained: true,
      relationRetained: false,
      lifecycle: "orphaned"
    },
    {
      name: "uses a valid Agent mirror only when the canonical session is absent",
      threadId: V18_THREAD_ID,
      agentId: V18_AGENT_ID,
      mutate(db: Database.Database) {
        db.prepare("DELETE FROM sessions WHERE thread_id=?").run(V18_THREAD_ID);
      },
      sessionRetained: true,
      relationRetained: true,
      lifecycle: "waiting-input"
    }
  ])("$name", ({
    mutate,
    threadId,
    agentId,
    sessionRetained,
    relationRetained,
    lifecycle
  }) => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-context-mismatch-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const legacy = new Database(file);
    mutate(legacy);
    legacy.close();

    const store = new BridgeStateStore({ file });
    expect(store.listSessions().some((session) => session.threadId === threadId))
      .toBe(sessionRetained);
    expect(store.listAgentThreads(agentId).some((thread) => thread.threadId === threadId))
      .toBe(relationRetained);
    expect(store.getAgent(agentId)).toMatchObject({
      lifecycle,
      currentThreadId: relationRetained ? threadId : undefined
    });
    const current = new Database(file, { readonly: true });
    expect(current.pragma("foreign_key_check")).toEqual([]);
    current.close();
    store.close();
  });

  it("rolls back an interrupted rebuild and reuses one recovery backup on retry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-retry-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file, { malformedJobPayload: true });

    expect(() => new BridgeStateStore({ file })).toThrow(/malformed JSON|Invalid job payload/);
    expect(readSchemaVersion(file)).toBe(18);
    expect(readMeta(file, "schema_v19_upgrade_source")).toBe("18");
    expect(readdirSync(root).filter((name) => name.includes("pre-v18-to-v31"))).toHaveLength(1);
    const failed = new Database(file);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'legacy_v18_%'").all()).toEqual([]);
    failed.prepare("UPDATE jobs SET payload='{}' WHERE job_id=?").run(V18_RUNNING_JOB_ID);
    failed.close();

    let store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(31);
    expect(store.getMeta("schema_v19_source_version")).toBe("18");
    expect(store.getMeta("schema_v19_upgrade_source")).toBeUndefined();
    store.close();
    store = new BridgeStateStore({ file });
    store.close();
    expect(readdirSync(root).filter((name) => name.includes("pre-v18-to-v31"))).toHaveLength(1);
  });

  it("replaces a stale same-version backup before beginning a new upgrade", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-stale-backup-"));
    const file = path.join(root, "state.sqlite");
    const stale = path.join(root, "stale.sqlite");
    const backup = `${file}.pre-v18-to-v31.sqlite`;
    createSchema18Fixture(file);
    createSchema18Fixture(stale);
    const current = new Database(file);
    current.prepare("INSERT INTO bridge_meta(key,value) VALUES ('backup_probe','current')").run();
    current.close();
    const old = new Database(stale);
    old.prepare("INSERT INTO bridge_meta(key,value) VALUES ('backup_probe','stale')").run();
    old.close();
    copyFileSync(stale, backup);

    const store = new BridgeStateStore({ file });
    store.close();

    expect(readMeta(backup, "backup_probe")).toBe("current");
    expect(readSchemaVersion(backup)).toBe(18);
    expect(readdirSync(root).filter((name) => name.includes("pre-v18-to-v31"))).toHaveLength(1);
  });

  it("keeps the original recovery point when a multi-checkpoint upgrade resumes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-multistep-retry-"));
    const file = path.join(root, "state.sqlite");
    const original = path.join(root, "original-v3.sqlite");
    const originalBackup = `${file}.pre-v3-to-v31.sqlite`;
    createSeededSchema3Fixture(original);
    const databaseId = "77777777-7777-4777-8777-777777777777";
    const originalDatabase = new Database(original);
    originalDatabase.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_database_id',?)")
      .run(databaseId);
    originalDatabase.close();
    copyFileSync(original, originalBackup);
    chmodSync(originalBackup, 0o600);

    createSchema18Fixture(file, { malformedJobPayload: true });
    const partial = new Database(file);
    partial.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_database_id',?)")
      .run(databaseId);
    partial.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_v19_upgrade_source','3')").run();
    partial.close();
    createMigrationBackupMetadata({
      databaseFile: file,
      backupFile: originalBackup,
      databaseId,
      sourceSchema: 3,
      targetSchema: 31
    });

    expect(() => new BridgeStateStore({ file })).toThrow(/malformed JSON|Invalid job payload/);
    expect(readSchemaVersion(file)).toBe(18);
    expect(readMeta(file, "schema_v19_upgrade_source")).toBe("3");
    expect(readSchemaVersion(originalBackup)).toBe(3);
    expect(existsSync(`${file}.pre-v18-to-v31.sqlite`)).toBe(false);

    const repaired = new Database(file);
    repaired.prepare("UPDATE jobs SET payload='{}' WHERE job_id=?").run(V18_RUNNING_JOB_ID);
    repaired.close();
    const store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(31);
    expect(store.getMeta("schema_v19_source_version")).toBe("3");
    expect(store.getMeta("schema_v19_upgrade_source")).toBeUndefined();
    store.close();
    expect(readdirSync(root).filter((name) => name.includes("pre-v"))).toEqual([
      path.basename(originalBackup)
    ]);
  });

  it("refuses to resume when the recorded original recovery point is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-schema-missing-backup-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const partial = new Database(file);
    partial.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_database_id',?)")
      .run("88888888-8888-4888-8888-888888888888");
    partial.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_v19_upgrade_source','3')").run();
    partial.close();

    expect(() => new BridgeStateStore({ file })).toThrow(/original v3 recovery backup is missing/);
    expect(readSchemaVersion(file)).toBe(18);
    expect(readMeta(file, "schema_v19_upgrade_source")).toBe("3");
    expect(readdirSync(root).filter((name) => name.includes("pre-v"))).toEqual([]);
  });

  it.each(["1", "2"])("rejects unsupported schema %s without changing it", (version) => {
    const root = mkdtempSync(path.join(tmpdir(), `bridge-schema-v${version}-`));
    const file = path.join(root, "state.sqlite");
    const db = new Database(file);
    db.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;");
    db.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_version',?)").run(version);
    db.close();
    expect(() => new BridgeStateStore({ file })).toThrow(`Unsupported bridge state database schema version: ${version}.`);
    expect(readSchemaVersion(file)).toBe(Number(version));
    expect(readdirSync(root).filter((name) => name.includes("pre-v"))).toEqual([]);
  });
});

function schemaInventory(file: string): unknown[] {
  const db = new Database(file, { readonly: true });
  const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as Array<{
      type:string;name:string;tbl_name:string;sql:string|null;
    }>;
  db.close();
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: row.sql?.replace(/\s+/gu, " ").trim() ?? null
  }));
}

function readSchemaVersion(file: string): number {
  const db = new Database(file, { readonly: true });
  const row = db.prepare("SELECT value FROM bridge_meta WHERE key='schema_version'").get() as { value: string };
  db.close();
  return Number(row.value);
}

function readMeta(file: string, key: string): string | undefined {
  const db = new Database(file, { readonly: true });
  const row = db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  db.close();
  return row?.value;
}

function tableCount(db: Database.Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function deprecatedCurrentObjects(db: Database.Database): unknown[] {
  return db.prepare(`SELECT type,name FROM sqlite_master WHERE
    name IN ('scope_versions','job_summaries') OR
    (sql IS NOT NULL AND (
      lower(sql) LIKE '%project_label%' OR
      lower(sql) LIKE '%project_uuid%' OR
      lower(sql) LIKE '%project_name_snapshot%' OR
      lower(sql) LIKE '%archived_at%' AND name='agents'
    )) ORDER BY type,name`).all();
}
