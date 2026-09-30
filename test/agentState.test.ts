import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";
const ACTIVITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTIVITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("scope-level bridge Agents", () => {
  it("rejects linking an unowned retained session through a conflicting Agent context", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const agent = store.createAgent({ scopeId: SCOPE_A, agentName: "Context guard" });
    store.upsertSession({
      threadId: "retained-thread",
      scopeId: SCOPE_B,
      backendKind: "app-server",
      cwd: "/workspace/original",
      sandbox: "read-only",
      lastUsedAt: 1
    });

    expect(() => store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "retained-thread",
      backendKind: "app-server",
      cwd: "/workspace/original",
      sandbox: "read-only",
      contextMode: "continue"
    })).toThrow(/PROJECT_CONTEXT_CONFLICT.*conversation scopes/);
    expect(store.listAgentThreads(agent.agentId)).toEqual([]);
    store.close();
  });

  it("guards recovery detach inside the assignment transaction", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    store.createActivity({ activityId: ACTIVITY_A, scopeId: SCOPE_A, title: "Recovery goal" });
    const agent = store.createAgent({ scopeId: SCOPE_A, agentName: "Recovery Agent" });
    const assignment = store.assignAgent({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      contextMode: "fresh"
    });
    const active = store.setAgentExecutionState(agent.agentId, "active", { currentJobId: "job-active" });

    expect(() => store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: active.version
    })).toThrow(/AGENT_BUSY/);
    expect(store.listActivityAgentAssignments(ACTIVITY_A, agent.agentId)[0]?.releasedAt).toBeUndefined();

    const idle = store.setAgentExecutionState(agent.agentId, "idle");
    expect(() => store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: idle.version - 1
    })).toThrow(/AGENT_VERSION_CHANGED/);

    const detached = store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: idle.version
    });
    expect(detached).toMatchObject({
      alreadyReleased: false,
      assignment: { assignmentId: assignment.assignmentId, releasedAt: expect.any(Number) },
      agent: { version: idle.version + 1 }
    });
    const replayedState = store.detachIdleAgentAssignment({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      expectedAgentVersion: detached.agent.version
    });
    expect(replayedState).toMatchObject({
      alreadyReleased: true,
      assignment: { assignmentId: assignment.assignmentId }
    });
    store.close();
  });

  it("persists normalized names, assignments, current/history threads, and mutations", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "bridge-agent-state-")), "state.sqlite");
    const store = new BridgeStateStore({ file });
    const projectCwd = realpathSync(mkdtempSync(path.join(tmpdir(), "bridge-agent-project-")));
    const project = store.applyProjectOperations(
      [{ kind: "add", project: { name: "Codex MCP Bridge", cwd: projectCwd } }],
      0,
      []
    ).projects[0]!;
    store.createActivity({
      activityId: ACTIVITY_A,
      scopeId: SCOPE_A,
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      projectCwd,
      title: "Original goal",
      now: 10
    });
    const agent = store.createAgent({ scopeId: SCOPE_A, agentName: "Ａlice", now: 20 });
    expect(agent).toMatchObject({ agentName: "Ａlice", normalizedName: "ａlice", lifecycle: "idle" });
    expect(() => store.createAgent({ scopeId: SCOPE_A, agentName: "ＡLICE", now: 21 }))
      .toThrow(/AGENT_NAME_CONFLICT/);
    expect(store.createAgent({ scopeId: SCOPE_A, agentName: "ALICE", now: 21 }).normalizedName)
      .toBe("alice");
    expect(store.createAgent({ scopeId: SCOPE_B, agentName: "alice", now: 22 }).scopeId).toBe(SCOPE_B);

    const firstAssignment = store.assignAgent({
      activityId: ACTIVITY_A,
      agentId: agent.agentId,
      contextMode: "fresh",
      role: "implementation",
      now: 30
    });
    store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-original",
      sessionId: "session-tree-1",
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      backendKind: "app-server",
      cwd: projectCwd,
      sandbox: "read-only",
      contextMode: "fresh",
      now: 40
    });
    expect(() => store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-original",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectName: "Other project",
      backendKind: "app-server",
      cwd: projectCwd,
      sandbox: "read-only",
      contextMode: "continue",
      now: 41
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    expect(() => store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-original",
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      backendKind: "app-server",
      cwd: "/workspace/switched",
      sandbox: "read-only",
      contextMode: "continue",
      now: 42
    })).toThrow(/PROJECT_CONTEXT_CONFLICT/);
    expect(store.releaseAgentAssignment(ACTIVITY_A, agent.agentId, 45)).toMatchObject({
      assignmentId: firstAssignment.assignmentId,
      releasedAt: 45
    });

    store.createActivity({
      activityId: ACTIVITY_B,
      scopeId: SCOPE_A,
      continuationOfActivityId: ACTIVITY_A,
      title: "Linked goal",
      now: 50
    });
    store.assignAgent({
      activityId: ACTIVITY_B,
      agentId: agent.agentId,
      contextMode: "fork",
      role: "verification",
      now: 55
    });
    store.linkAgentThread({
      agentId: agent.agentId,
      threadId: "thread-fork",
      sessionId: "session-tree-1",
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      backendKind: "app-server",
      cwd: projectCwd,
      sandbox: "read-only",
      contextMode: "fork",
      forkedFromThreadId: "thread-original",
      now: 60
    });
    const renamed = store.renameAgent(agent.agentId, "  Builder  ", 70);
    expect(renamed).toMatchObject({ agentId: agent.agentId, agentName: "Builder", currentThreadId: "thread-fork" });
    expect(store.listAgents(SCOPE_A)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: agent.agentId, lifecycle: "idle" })
    ]));
    store.recordAgentMutation(SCOPE_A, "mutation-1", "hash-1", { ok: true, action: "rename" }, 100);
    store.close();

    const restored = new BridgeStateStore({ file });
    expect(restored.schemaVersion).toBe(31);
    expect(restored.getActivity(ACTIVITY_A)).toMatchObject({
      lifecycle: "open",
      projectId: project.id,
      projectName: "Codex MCP Bridge"
    });
    expect(restored.getActivity(ACTIVITY_B)).toMatchObject({
      continuationOfActivityId: ACTIVITY_A,
      cardGeneration: 1,
      projectId: project.id,
      projectName: "Codex MCP Bridge"
    });
    expect(restored.getActivityProjectAdmission(ACTIVITY_B)).toEqual({
      projectId: project.id,
      projectName: "Codex MCP Bridge",
      projectCwd
    });
    expect(restored.getAgent(agent.agentId)).toMatchObject({
      scopeId: SCOPE_A,
      agentName: "Builder",
      lifecycle: "idle",
      currentThreadId: "thread-fork"
    });
    expect(restored.listAgentThreads(agent.agentId)).toEqual([
      expect.objectContaining({
        threadId: "thread-original",
        sessionId: "session-tree-1",
        projectId: project.id,
        projectName: "Codex MCP Bridge",
        contextMode: "fresh",
        isCurrent: false,
        replacedAt: 60
      }),
      expect.objectContaining({
        threadId: "thread-fork",
        sessionId: "session-tree-1",
        projectId: project.id,
        projectName: "Codex MCP Bridge",
        contextMode: "fork",
        isCurrent: true,
        forkedFromThreadId: "thread-original"
      })
    ]);
    expect(restored.listActivityAgentAssignments(undefined, agent.agentId)).toEqual([
      expect.objectContaining({
        activityId: ACTIVITY_A,
        role: "implementation",
        contextMode: "fresh",
        releasedAt: 45
      }),
      expect.objectContaining({
        activityId: ACTIVITY_B,
        role: "verification",
        contextMode: "fork",
        releasedAt: undefined
      })
    ]);
    expect(restored.getAgentMutation(SCOPE_A, "mutation-1")).toEqual({
      actionHash: "hash-1",
      result: { ok: true, action: "rename" }
    });
    restored.close();
  });
});
