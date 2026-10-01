import { createHash } from "node:crypto";
import type { BridgeStateStore } from "./stateStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

const PREFIX = "task_followup_v1/";
const APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
/** stepId is retained only for previously persisted v1 Jobs, never new input. */
export type ApprovedFollowup = { followupId?: string; stepId?: string; promptSha256: string };
export type FollowupReference = { followupId: string; reviewedVersion: number };
export type FollowupView = {
  followupId: string; requestId: string;
  status: "approved-pending" | "admitted" | "expired";
};
export const FOLLOWUP_ID_PATTERN = /^fup_[a-f0-9]{96}$/;
type FollowupJob = {
  jobId: string; scopeId: string; activityId?: string; agentId?: string;
  requestId: string; approvedFollowups?: ApprovedFollowup[]; followup?: FollowupReference;
  createdAt?: number; mcpPrincipal?: string;
  sandbox?: string; threadId?: string; executionDecision?: { effectiveSelection: { model: string; reasoningEffort: string; serviceTier?: string } };
};
type FollowupReceipt = ApprovedFollowup & {
  followupId: string;
  parentJobId: string; scopeId: string; activityId: string; agentId: string;
  mcpPrincipal?: string;
  requestId: string; expiresAt: number; admittedJobId?: string;
  reviewedVersion?: number; reviewClaimedAt?: number;
};

export function approvedFollowupDigests(steps?: Array<{ prompt: string }>): ApprovedFollowup[] | undefined {
  return steps?.map(step => ({ promptSha256: promptDigest(step.prompt) }));
}

export function promptDigest(prompt: string): string { return createHash("sha256").update(prompt, "utf8").digest("hex"); }

/** Issued from the system-created parent Job and an internal declaration slot.
 * The encoding supports exact indexed lookup, including v1 receipts, without a
 * global scan or another index journal. Treat the entire value as opaque. */
export function issueApprovedFollowups(jobId: string, steps?: ApprovedFollowup[]): ApprovedFollowup[] | undefined {
  return steps?.map((step, index) => ({ ...step, followupId: step.followupId ||
    followupIdForSlot(jobId, createHash("sha256").update(step.stepId ?? `codex-mcp-bridge/followup-slot/v2\0${index}`).digest("hex")) }));
}

function followupIdForSlot(jobId: string, slot: string): string {
  return "fup_" + jobId.replaceAll("-", "").toLowerCase() + slot;
}

function followupTarget(followupId: string): { jobId: string; slot: string } {
  if (!FOLLOWUP_ID_PATTERN.test(followupId)) throw new Error("FOLLOWUP_NOT_APPROVED: Unknown issued followup reference.");
  const parent = followupId.slice(4, 36);
  return { jobId: `${parent.slice(0, 8)}-${parent.slice(8, 12)}-${parent.slice(12, 16)}-${parent.slice(16, 20)}-${parent.slice(20)}`,
    slot: followupId.slice(36) };
}

/** Persisted v1 references are adapted as data; no old caller alias is accepted. */
export function readFollowupReference(value: FollowupReference | { jobId: string; stepId: string; reviewedVersion: number }): FollowupReference {
  return "followupId" in value ? value : { reviewedVersion: value.reviewedVersion,
    followupId: followupIdForSlot(value.jobId, createHash("sha256").update(value.stepId).digest("hex")) };
}

function canonicalRequestId(scopeId: string, jobId: string, step: ApprovedFollowup): string {
  const identity = step.stepId === undefined
    ? "codex-mcp-bridge/followup/v2\0" + JSON.stringify([scopeId, jobId, step.followupId])
    : "codex-mcp-bridge/followup/v1\0" + JSON.stringify([scopeId, jobId, step.stepId]);
  const bytes = createHash("sha1").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** IDs and canonical request receipts belong to the ordinary Job admission.
 * GPT references returned IDs; it neither names nor recreates workflow stages. */
export class TaskFollowupStore {
  constructor(private readonly state: BridgeStateStore) {}

  get(followupId: string): FollowupReceipt | undefined {
    const { jobId, slot } = followupTarget(followupId);
    const raw = this.state.getMeta(`${PREFIX}${jobId}/${slot}`);
    if (raw === undefined) return undefined;
    const receipt = parseJsonTextStrict(raw, "Approved followup receipt") as FollowupReceipt;
    if (receipt.parentJobId !== jobId || receipt.followupId && receipt.followupId !== followupId) {
      throw new Error("FOLLOWUP_ADMISSION_CONFLICT: The issued reference does not match its receipt.");
    }
    return { ...receipt, followupId };
  }

  references(job: Pick<FollowupJob, "jobId" | "scopeId" | "mcpPrincipal" | "approvedFollowups">, now = Date.now()): FollowupView[] {
    return (issueApprovedFollowups(job.jobId, job.approvedFollowups) || []).map(step => {
      const receipt = this.get(step.followupId!);
      if (receipt && (receipt.scopeId !== job.scopeId || receipt.mcpPrincipal !== job.mcpPrincipal || receipt.promptSha256 !== step.promptSha256)) {
        throw new Error("FOLLOWUP_OWNER_REQUIRED: Issued reference does not match the predecessor's retained approval.");
      }
      return { followupId: step.followupId!, requestId: receipt?.requestId || canonicalRequestId(job.scopeId, job.jobId, step),
        status: receipt?.admittedJobId ? "admitted" : receipt && receipt.expiresAt > now ? "approved-pending" : "expired" };
    });
  }

  /** The caller invokes this inside the Job transaction, before execution. */
  admit(job: FollowupJob): void {
    if (job.followup) {
      const receipt = this.get(job.followup.followupId);
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
        this.state.setMeta(this.key(receipt.followupId), JSON.stringify({
          ...receipt, admittedJobId: job.jobId, reviewedVersion: job.followup.reviewedVersion, reviewClaimedAt: Date.now()
        }));
      }
    }
    for (const step of issueApprovedFollowups(job.jobId, job.approvedFollowups) || []) {
      if (!job.activityId || !job.agentId) throw new Error("FOLLOWUP_OWNER_REQUIRED: Approval must belong to an Activity and Agent.");
      if (followupTarget(step.followupId!).jobId !== job.jobId) throw new Error("FOLLOWUP_OWNER_REQUIRED: Issued reference belongs to a different predecessor.");
      const existing = this.get(step.followupId!);
      if (existing) {
        if (existing.promptSha256 !== step.promptSha256 || existing.scopeId !== job.scopeId) throw new Error("FOLLOWUP_APPROVAL_CONFLICT: Approval is immutable.");
        continue;
      }
      const requestId = canonicalRequestId(job.scopeId, job.jobId, step);
      this.state.setMeta(this.key(step.followupId!), JSON.stringify({
        ...step, parentJobId: job.jobId, scopeId: job.scopeId, activityId: job.activityId, agentId: job.agentId,
        followupId: step.followupId!,
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
        const receipt = parseJsonTextStrict(row.value, "Approved followup receipt") as FollowupReceipt;
        if (!receipt.admittedJobId && receipt.expiresAt <= now) { this.state.deleteMeta(row.key); removed += 1; }
      }
      if (rows.length === 500) this.state.setMeta(cursorKey, rows[rows.length - 1]!.key);
      else this.state.deleteMeta(cursorKey);
      return removed;
    });
  }

  private key(followupId: string): string {
    const { jobId, slot } = followupTarget(followupId);
    return `${PREFIX}${jobId}/${slot}`;
  }
}
