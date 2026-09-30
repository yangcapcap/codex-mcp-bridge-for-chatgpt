import { createHash } from "node:crypto";
import type { BridgeStateStore } from "./stateStore.js";

const PREFIX = "task_followup_v1/";
const APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
export type ApprovedFollowup = { stepId: string; promptSha256: string };
export type FollowupReference = { jobId: string; stepId: string; reviewedVersion: number };
type FollowupJob = {
  jobId: string; scopeId: string; activityId?: string; agentId?: string;
  requestId: string; approvedFollowups?: ApprovedFollowup[]; followup?: FollowupReference;
  createdAt?: number; mcpPrincipal?: string;
  sandbox?: string; threadId?: string; executionDecision?: { effectiveSelection: { model: string; reasoningEffort: string; serviceTier?: string } };
};
type FollowupReceipt = ApprovedFollowup & {
  parentJobId: string; scopeId: string; activityId: string; agentId: string;
  mcpPrincipal?: string;
  requestId: string; expiresAt: number; admittedJobId?: string;
  reviewedVersion?: number; reviewClaimedAt?: number;
};

export function approvedFollowupDigests(steps?: Array<{ stepId: string; prompt: string }>): ApprovedFollowup[] | undefined {
  return steps?.map(step => ({ stepId: step.stepId, promptSha256: promptDigest(step.prompt) }));
}

export function promptDigest(prompt: string): string { return createHash("sha256").update(prompt, "utf8").digest("hex"); }

/** Durable approval identity lives with the ordinary Job admission. GPT need not
 * remember a generated UUID across runs: (scope, predecessor, approved step)
 * always resolves to the one receipt. Only prompt hashes are retained. */
export class TaskFollowupStore {
  constructor(private readonly state: BridgeStateStore) {}

  get(jobId: string, stepId: string): FollowupReceipt | undefined {
    const raw = this.state.getMeta(this.key(jobId, stepId));
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  /** The caller invokes this inside the Job transaction, before execution. */
  admit(job: FollowupJob): void {
    if (job.followup) {
      const receipt = this.get(job.followup.jobId, job.followup.stepId);
      if (!receipt || receipt.scopeId !== job.scopeId || receipt.activityId !== job.activityId ||
          receipt.mcpPrincipal !== job.mcpPrincipal ||
          receipt.agentId !== job.agentId || receipt.requestId !== job.requestId ||
          receipt.admittedJobId && receipt.admittedJobId !== job.jobId ||
          !receipt.admittedJobId && receipt.expiresAt <= Date.now()) {
        throw new Error("FOLLOWUP_ADMISSION_CONFLICT: The approved step cannot admit a different Job.");
      }
      if (!receipt.admittedJobId) {
        const parent = this.state.followupParent(receipt.parentJobId, receipt.scopeId, job.followup.reviewedVersion);
        const selection = job.executionDecision?.effectiveSelection;
        if (!parent || parent.threadId !== job.threadId || parent.sandbox !== job.sandbox ||
            !selection || !parent.selection ||
            ["model", "reasoningEffort", "serviceTier"].some(key =>
              (parent.selection![key] || null) !== (selection[key as keyof typeof selection] || null))) {
          throw new Error("FOLLOWUP_REVIEW_REQUIRED: The predecessor, context, access or model changed before atomic admission.");
        }
        this.state.setMeta(this.key(receipt.parentJobId, receipt.stepId), JSON.stringify({
          ...receipt, admittedJobId: job.jobId, reviewedVersion: job.followup.reviewedVersion, reviewClaimedAt: Date.now()
        }));
      }
    }
    for (const step of job.approvedFollowups || []) {
      if (!job.activityId || !job.agentId) throw new Error("FOLLOWUP_OWNER_REQUIRED: Approval must belong to an Activity and Agent.");
      const existing = this.get(job.jobId, step.stepId);
      if (existing) {
        if (existing.promptSha256 !== step.promptSha256 || existing.scopeId !== job.scopeId) throw new Error("FOLLOWUP_APPROVAL_CONFLICT: Approval is immutable.");
        continue;
      }
      const bytes = createHash("sha1").update("codex-mcp-bridge/followup/v1\0" + JSON.stringify([job.scopeId, job.jobId, step.stepId])).digest().subarray(0, 16);
      bytes[6] = (bytes[6]! & 15) | 0x50;
      bytes[8] = (bytes[8]! & 63) | 0x80;
      const hex = bytes.toString("hex");
      const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      this.state.setMeta(this.key(job.jobId, step.stepId), JSON.stringify({
        ...step, parentJobId: job.jobId, scopeId: job.scopeId, activityId: job.activityId, agentId: job.agentId,
        mcpPrincipal: job.mcpPrincipal,
        requestId, expiresAt: (job.createdAt || Date.now()) + APPROVAL_LIFETIME_MS
      } satisfies FollowupReceipt));
    }
  }

  /** Unconsumed approvals expire. Admission tombstones remain reference-aware
   * proof, like the existing archived Job/request receipts. */
  maintain(now = Date.now()): number {
    return this.state.transaction(() => {
      const cursorKey = "task_followup_gc_v1";
      const cursor = this.state.getMeta(cursorKey);
      const rows = this.state.listMeta(PREFIX, 500, cursor);
      let removed = 0;
      for (const row of rows) {
        const receipt = JSON.parse(row.value) as FollowupReceipt;
        if (!receipt.admittedJobId && receipt.expiresAt <= now) { this.state.deleteMeta(row.key); removed += 1; }
      }
      if (rows.length === 500) this.state.setMeta(cursorKey, rows[rows.length - 1]!.key);
      else this.state.deleteMeta(cursorKey);
      return removed;
    });
  }

  private key(jobId: string, stepId: string): string {
    return `${PREFIX}${jobId}/${createHash("sha256").update(stepId).digest("hex")}`;
  }
}
