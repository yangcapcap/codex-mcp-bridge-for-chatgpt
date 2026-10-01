import { describe, expect, it } from "vitest";
import {
  completionMessageErrorDisposition,
  completionResultMessage,
  reconcileDashboardPageCaches
} from "../src/dashboardCard.js";

type Row = { id: string };
type Page = { offset: number; returned: number; total: number; hasNext: boolean };

const page = (offset: number, hasNext: boolean): Page => ({
  offset,
  returned: 1,
  total: 2,
  hasNext
});

const mergeRows = (current: Row[], incoming: Row[]): Row[] => {
  const merged = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) merged.set(row.id, row);
  return [...merged.values()];
};
const rowKey = (row: Row): string => row.id;

describe("Dashboard completion message outcomes", () => {
  const jobId = "21300000-0000-4000-8000-000000000001";
  const exactResult = (answer = "Fixture A from this connection") => ({
    structuredContent: { kind: "job", items: [{ type: "job", id: jobId, terminal: true, state: "completed", answer }] },
    content: [{ type: "text", text: answer }],
    _meta: { privateProof: "never-send-this-proof" }
  });

  it("hands off the exact result obtained through the component connection without a named-app lookup", () => {
    const message = completionResultMessage(exactResult(), jobId);
    expect(message).toContain("Fixture A from this connection");
    expect(message).toContain("select it explicitly");
    expect(message).not.toContain("Use only Codex MCP Bridge for ChatGPT");
    expect(message).not.toContain("Call codex_status");
    expect(message).not.toContain("never-send-this-proof");
    expect(message).not.toContain("_meta");
  });

  it("keeps same-ID results from separate installations distinct instead of guessing a connection", () => {
    expect(completionResultMessage(exactResult("trial connection"), jobId)).not.toContain("operational connection");
    expect(completionResultMessage(exactResult("operational connection"), jobId)).not.toContain("trial connection");
  });

  it.each([
    { isError: true, ...exactResult() },
    { ...exactResult(), structuredContent: { kind: "overview", items: [] } },
    { ...exactResult(), structuredContent: { kind: "job", items: [{ type: "job", id: "other", terminal: true }] } },
    { ...exactResult(), structuredContent: { kind: "job", items: [{ type: "job", id: jobId, terminal: false }] } },
    { ...exactResult(), structuredContent: { kind: "job", items: [exactResult().structuredContent.items[0], exactResult().structuredContent.items[0]] } },
    null
  ])("refuses an error, mismatched, nonterminal, ambiguous, or malformed connection result %#", (result) => {
    expect(() => completionResultMessage(result, jobId)).toThrow("Select the original connection explicitly");
  });

  it("copies only public text blocks and never carries private metadata from a content block", () => {
    const result = { ...exactResult(), content: [{ type: "text", text: "exact text", _meta: { secret: "block-private" } }, { type: "image", data: "image-private" }] };
    const message = completionResultMessage(result, jobId);
    expect(message).toContain("exact text");
    expect(message).not.toContain("block-private");
    expect(message).not.toContain("image-private");
  });

  it("retries only a resolved explicit host rejection", () => {
    expect(completionMessageErrorDisposition({ code: "COMPLETION_HOST_REJECTED" }))
      .toBe("rejected");
    expect(completionMessageErrorDisposition({ code: "MCP_RPC_RESPONSE_ERROR" }))
      .toBe("rejected");
  });

  it("preserves timeout, disconnect, teardown, and unknown throws as uncertain", () => {
    expect(completionMessageErrorDisposition({ code: "COMPLETION_MESSAGE_TIMEOUT" }))
      .toBe("uncertain");
    expect(completionMessageErrorDisposition({ code: "ECONNRESET" }))
      .toBe("uncertain");
    expect(completionMessageErrorDisposition(new Error("Codex overview unmounted")))
      .toBe("uncertain");
    expect(completionMessageErrorDisposition(undefined)).toBe("uncertain");
  });
});

describe("Dashboard independent page caches", () => {
  it("preserves recent rows when idle load-more appends its next page", () => {
    const initial = {
      terminalRows: [{ id: "recent-1" }],
      idleRows: [{ id: "idle-1" }],
      terminalPagination: page(0, true),
      idlePagination: page(0, true)
    };
    const afterRecent = reconcileDashboardPageCaches(
      initial,
      {
        activeRows: [],
        terminalRows: [{ id: "recent-2" }],
        idleRows: [{ id: "idle-1" }],
        terminalPagination: page(1, false),
        idlePagination: page(0, true)
      },
      { bucket: "terminal", requestedOffset: 1 },
      mergeRows,
      rowKey
    );
    const afterIdle = reconcileDashboardPageCaches(
      afterRecent,
      {
        activeRows: [],
        terminalRows: [{ id: "recent-1" }],
        idleRows: [{ id: "idle-2" }],
        terminalPagination: page(0, true),
        idlePagination: page(1, false)
      },
      { bucket: "idle", requestedOffset: 1 },
      mergeRows,
      rowKey
    );

    expect(afterIdle.terminalRows.map((row) => row.id)).toEqual([
      "recent-1",
      "recent-2"
    ]);
    expect(afterIdle.idleRows.map((row) => row.id)).toEqual([
      "idle-1",
      "idle-2"
    ]);
    expect(afterIdle.terminalPagination).toEqual(page(1, false));
    expect(afterIdle.idlePagination).toEqual(page(1, false));
  });

  it("infers a delayed paged response and resets both caches only for a fresh page-zero snapshot", () => {
    const loaded = {
      terminalRows: [{ id: "recent-1" }, { id: "recent-2" }],
      idleRows: [{ id: "idle-1" }, { id: "idle-2" }],
      terminalPagination: page(1, false),
      idlePagination: page(1, false)
    };
    const delayedRecent = reconcileDashboardPageCaches(
      loaded,
      {
        activeRows: [],
        terminalRows: [{ id: "recent-3" }],
        idleRows: [{ id: "idle-1" }],
        terminalPagination: { ...page(2, false), total: 3 },
        idlePagination: page(0, true)
      },
      null,
      mergeRows,
      rowKey
    );
    expect(delayedRecent.terminalRows.map((row) => row.id)).toEqual([
      "recent-1",
      "recent-2",
      "recent-3"
    ]);
    expect(delayedRecent.idleRows).toEqual(loaded.idleRows);

    const refreshed = reconcileDashboardPageCaches(
      delayedRecent,
      {
        activeRows: [],
        terminalRows: [{ id: "recent-new" }],
        idleRows: [{ id: "idle-new" }],
        terminalPagination: page(0, true),
        idlePagination: page(0, true)
      },
      null,
      mergeRows,
      rowKey
    );
    expect(refreshed.terminalRows).toEqual([{ id: "recent-new" }]);
    expect(refreshed.idleRows).toEqual([{ id: "idle-new" }]);
  });

  it("rebases a bucket when the server clamps a stale load-more offset", () => {
    const loaded = {
      terminalRows: [{ id: "recent-old-1" }, { id: "recent-old-2" }],
      idleRows: [{ id: "idle-1" }],
      terminalPagination: { ...page(1, false), total: 2 },
      idlePagination: page(0, false)
    };
    const rebased = reconcileDashboardPageCaches(
      loaded,
      {
        activeRows: [],
        terminalRows: [{ id: "recent-current" }],
        idleRows: [{ id: "idle-1" }],
        terminalPagination: { ...page(0, false), total: 1 },
        idlePagination: page(0, false)
      },
      { bucket: "terminal", requestedOffset: 2 },
      mergeRows,
      rowKey
    );

    expect(rebased.terminalRows).toEqual([{ id: "recent-current" }]);
    expect(rebased.terminalPagination.offset).toBe(0);
  });

  it("evicts cached terminal and idle copies when an Agent becomes active", () => {
    const reconciled = reconcileDashboardPageCaches(
      {
        terminalRows: [{ id: "moved" }, { id: "recent" }],
        idleRows: [{ id: "moved" }, { id: "idle" }],
        terminalPagination: { ...page(1, false), total: 2 },
        idlePagination: { ...page(1, false), total: 2 }
      },
      {
        activeRows: [{ id: "moved" }],
        terminalRows: [{ id: "recent" }],
        idleRows: [{ id: "idle" }],
        terminalPagination: page(0, false),
        idlePagination: page(0, false)
      },
      null,
      mergeRows,
      rowKey
    );

    expect(reconciled.terminalRows).toEqual([{ id: "recent" }]);
    expect(reconciled.idleRows).toEqual([{ id: "idle" }]);
  });
});
