/** Explicit opt-in; normal recovery retains its force-stop behavior. */
export type ShutdownPolicy = Readonly<{ allowSigkillEscalation: boolean; graceMs?: number }>;
export type ShutdownResult = Readonly<{
  exited: boolean;
  outcome: "exited" | "timeout" | "uncertain";
  survivors: number;
  signalFailures: number;
  identityChanges: number;
}>;
export const NONFORCING_SHUTDOWN: ShutdownPolicy = Object.freeze({ allowSigkillEscalation: false });
export function shutdownGrace(policy: ShutdownPolicy): number {
  const ms = policy?.graceMs ?? 1500;
  if (!policy || typeof policy !== "object" ||
      !Object.hasOwn(policy, "allowSigkillEscalation") ||
      Object.keys(policy).some(key => !["allowSigkillEscalation", "graceMs"].includes(key)) ||
      typeof policy.allowSigkillEscalation !== "boolean" || !Number.isSafeInteger(ms) || ms < 0 || ms > 60_000) {
    throw new Error("SHUTDOWN_POLICY_INVALID");
  }
  return ms;
}
export function shutdownResult(outcome: ShutdownResult["outcome"], survivors = 0,
  signalFailures = 0, identityChanges = 0): ShutdownResult {
  const result = { exited: outcome === "exited", outcome, survivors, signalFailures, identityChanges };
  if (!validShutdownResult(result)) throw new Error("SHUTDOWN_RESULT_INVALID");
  return Object.freeze(result);
}
export function validShutdownResult(value: unknown): value is ShutdownResult {
  return snapshotShutdownResult(value) !== undefined;
}
function snapshotShutdownResult(value: unknown): ShutdownResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ["exited", "outcome", "survivors", "signalFailures", "identityChanges"];
  if (Object.keys(descriptors).length !== 5 || keys.some(key => !descriptors[key] ||
      !Object.hasOwn(descriptors[key], "value"))) return undefined;
  const r = Object.fromEntries(keys.map(key => [key, descriptors[key].value])) as ShutdownResult;
  const valid =
    ["exited", "timeout", "uncertain"].includes(r.outcome) && typeof r.exited === "boolean" &&
    [r.survivors, r.signalFailures, r.identityChanges].every(n => Number.isSafeInteger(n) && n >= 0) &&
    r.exited === (r.outcome === "exited") && (!r.exited ||
      r.survivors === 0 && r.signalFailures === 0 && r.identityChanges === 0);
  return valid ? Object.freeze(r) : undefined;
  } catch { return undefined; }
}
/** A settled Promise<void>, rejected operation or absent receipt proves nothing. */
export async function boundedShutdown(operation: () => Promise<void | ShutdownResult>,
  timeoutMs = 6000): Promise<ShutdownResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 180_000) {
    throw new Error("SHUTDOWN_DEADLINE_INVALID");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(value => snapshotShutdownResult(value) ?? shutdownResult("uncertain"),
        () => shutdownResult("uncertain")),
      new Promise<ShutdownResult>(resolve => { timer = setTimeout(() => resolve(shutdownResult("uncertain")), timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
export function combineShutdown(results: readonly ShutdownResult[]): ShutdownResult {
  const snapshots = results.map(snapshotShutdownResult);
  if (snapshots.length === 0 || snapshots.some(result => !result)) return shutdownResult("uncertain");
  const retained = snapshots as ShutdownResult[];
  const sums = ["survivors", "signalFailures", "identityChanges"].map(key =>
    retained.reduce((total, result) => total + result[key as keyof Pick<ShutdownResult,
      "survivors" | "signalFailures" | "identityChanges">], 0));
  if (sums.some(sum => !Number.isSafeInteger(sum))) return shutdownResult("uncertain");
  return shutdownResult(retained.some(r => r.outcome === "uncertain") ? "uncertain" :
    retained.every(r => r.exited) ? "exited" : "timeout", sums[0], sums[1], sums[2]);
}
export type ShutdownObserver = { observeNonforcingExit?(): ShutdownResult | Promise<ShutdownResult> };
/** Fresh evidence may resolve a retained timeout; this operation sends no signal. */
export async function observeShutdown(target: ShutdownObserver): Promise<ShutdownResult> {
  if (!target.observeNonforcingExit) return shutdownResult("uncertain");
  try {
    const result = await target.observeNonforcingExit();
    return snapshotShutdownResult(result) ?? shutdownResult("uncertain");
  } catch { return shutdownResult("uncertain"); }
}
