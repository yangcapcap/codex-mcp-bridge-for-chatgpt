import { validShutdownResult, shutdownResult, type ShutdownResult } from "./shutdown.js";

/** A fresh pool owner plus exact worker generation and owned spawn identity. */
export type WorkerShutdownBinding = Readonly<{
  ownerId: string; workerId: string; workerGeneration: number;
  pid: number; processGroupId: number | null;
}>;
export type WorkerShutdownReceipt = Readonly<{
  binding: WorkerShutdownBinding; result: ShutdownResult;
}>;
export type WorkerShutdownSupervisor = Readonly<{
  /** Synchronous fence, before transport close and any exit callback can yield. */
  pinNonforcingShutdown(binding: WorkerShutdownBinding): true;
  closeNonforcing(binding: WorkerShutdownBinding): Promise<WorkerShutdownReceipt>;
  observeNonforcingExit(binding: WorkerShutdownBinding): Promise<WorkerShutdownReceipt>;
}>;
const keys = ["ownerId", "workerId", "workerGeneration", "pid", "processGroupId"] as const;
function ownData(value: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object") return;
    const d=Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(d).length!==names.length || names.some(k=>!Object.hasOwn(d,k)||!Object.hasOwn(d[k],"value"))) return;
    return Object.fromEntries(names.map(k=>[k,d[k].value]));
  } catch { return; }
}
export function snapshotWorkerShutdownBinding(value: unknown): WorkerShutdownBinding | undefined {
  const b=ownData(value,keys);
  if (!b || typeof b.ownerId!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.ownerId) ||
      typeof b.workerId!=="string" || !/^app-(0|[1-9][0-9]{0,8})$/.test(b.workerId) ||
      !Number.isSafeInteger(b.workerGeneration) || (b.workerGeneration as number)<1 ||
      !Number.isSafeInteger(b.pid) || (b.pid as number)<1 ||
      b.processGroupId!==null && (!Number.isSafeInteger(b.processGroupId)||(b.processGroupId as number)<1)) return;
  return Object.freeze(b) as WorkerShutdownBinding;
}
/** Copy exact data-only evidence; a void completion or other generation proves nothing. */
export function workerShutdownResult(value: unknown, expected: WorkerShutdownBinding): ShutdownResult {
  const receipt=ownData(value,["binding","result"]);
  const binding=snapshotWorkerShutdownBinding(receipt?.binding);
  if (!binding || keys.some(k=>binding[k]!==expected[k])) return shutdownResult("uncertain");
  const result=ownData(receipt?.result,["exited","outcome","survivors","signalFailures","identityChanges"]);
  // Validate a single copied snapshot rather than rereading caller-controlled descriptors.
  return result && validShutdownResult(result) ? Object.freeze(result) as ShutdownResult : shutdownResult("uncertain");
}
export function snapshotWorkerShutdownSupervisor(value: unknown): WorkerShutdownSupervisor | undefined {
  const names=["pinNonforcingShutdown","closeNonforcing","observeNonforcingExit"];
  const methods=ownData(value,names);
  if (!methods || names.some(k=>typeof methods[k]!=="function")) return;
  return Object.freeze(Object.fromEntries(names.map(k=>[k,Function.prototype.bind.call(methods[k] as Function,value)]))) as WorkerShutdownSupervisor;
}
