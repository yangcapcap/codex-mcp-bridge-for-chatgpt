import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { shutdownResult, type ShutdownResult } from "./shutdown.js";
import type {
  OperationalStateCommand,
  OperationalStateResult,
  OperationalStateService
} from "./stateService.js";

export const STATE_MAINTENANCE_SLICES = [
  "events",
  "history",
  "questions",
  "recovery",
  "receipts",
  "jobs"
] as const;

export type StateMaintenanceSlice = (typeof STATE_MAINTENANCE_SLICES)[number];
export type StateMaintenanceObservation = {
  slice: StateMaintenanceSlice;
  startedAt: number;
  durationMs: number;
  changed: number;
  failed: boolean;
  deferred: boolean;
};

/**
 * Runs one bounded storage concern at a time. It deliberately owns a timer
 * independent of thread release and automatic recovery controllers, so a
 * connection lifecycle cannot accidentally become the database GC clock.
 */
export class StateMaintenanceScheduler {
  lastError?: string;
  private timer?: NodeJS.Timeout;
  private pending = false;
  private closed = false;
  private nonforcingPinned = false;
  private nonforcingUnknown = false;
  private cursor = 0;
  private pendingCommand?: {slice: StateMaintenanceSlice; commandId: string; command: OperationalStateCommand};
  private deferredSince?: number;
  private readonly uncertainCommands = new Map<
    StateMaintenanceSlice,
    { commandId: string; command: OperationalStateCommand }
  >();
  private readonly observations: StateMaintenanceObservation[] = [];

  constructor(
    private readonly stateService: OperationalStateService,
    private readonly options: {
      intervalMs?: number;
      now?: () => number;
      changed?: () => void;
      shouldDefer?: () => boolean;
      maxDeferMs?: number;
      command?: (slice: StateMaintenanceSlice) => OperationalStateCommand;
      completed?: (
        command: OperationalStateCommand,
        result: OperationalStateResult
      ) => void;
    } = {}
  ) {}

  start(): void {
    if (this.closed || this.timer) return;
    const intervalMs = this.options.intervalMs ?? 5_000;
    if (this.closed) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647)
      throw new Error("STATE_BACKGROUND_INTERVAL_INVALID");
    this.timer = setInterval(() => { void this.sweep(); }, intervalMs);
    this.timer.unref();
    void this.sweep();
  }

  async sweep(slice?: StateMaintenanceSlice): Promise<StateMaintenanceObservation | undefined> {
    if (this.closed || this.pending) return;
    this.pending = true;
    const selected = slice || STATE_MAINTENANCE_SLICES[this.cursor % STATE_MAINTENANCE_SLICES.length]!;
    const now = this.options.now || Date.now;
    if (this.nonforcingPinned) {this.pending = false; return;}
    const startedAt = now();
    if (this.nonforcingPinned) {this.pending = false; return;}
    const configuredMaxDefer = this.options.maxDeferMs;
    if (this.nonforcingPinned) {this.pending = false; return;}
    if (configuredMaxDefer !== undefined && (typeof configuredMaxDefer !== "number" || !Number.isFinite(configuredMaxDefer)))
      throw new Error("STATE_BACKGROUND_DEFER_INVALID");
    const maxDeferMs = configuredMaxDefer === undefined ? undefined : Math.max(0,configuredMaxDefer);
    const shouldDefer = this.options.shouldDefer;
    if (this.nonforcingPinned) {this.pending = false; return;}
    const defer = !slice && shouldDefer?.call(this.options);
    if (this.nonforcingPinned) {this.pending = false; return;}
    if (defer) {
      this.deferredSince ??= startedAt;
      if (maxDeferMs === undefined || startedAt - this.deferredSince < maxDeferMs) {
        this.pending = false;
        return this.record({
          slice: selected,
          startedAt,
          durationMs: 0,
          changed: 0,
          failed: false,
          deferred: true
        });
      }
    }
    if (!slice) {
      this.deferredSince = undefined;
      this.cursor++;
    }
    const started = performance.now();
    let changed = 0;
    let failed = false;
    const uncertain = this.uncertainCommands.get(selected);
    const commandId = uncertain?.commandId ?? randomUUID();
    const wasUncertain = uncertain !== undefined;
    let command = uncertain?.command;
    let committed = false;
    try {
      if (!command) {
        const createCommand = this.options.command;
        if (this.nonforcingPinned) return;
        command = createCommand?.call(this.options,selected) ?? defaultMaintenanceCommand(selected);
      }
      if (this.nonforcingPinned) return;
      const execute = this.stateService.execute;
      if (this.nonforcingPinned) return;
      this.pendingCommand = {slice: selected, commandId, command};
      const result = await Reflect.apply(execute, this.stateService, [
        command,
        { commandId, aggregateKey: `maintenance:${selected}` }
      ]);
      if (this.nonforcingPinned) {
        this.uncertainCommands.set(selected, {commandId, command});
        return;
      }
      committed = true;
      const completed = this.options.completed;
      if (this.nonforcingPinned) return;
      if (completed?.call(this.options,command,result) !== undefined) this.nonforcingUnknown = true;
      if (this.nonforcingPinned) return;
      changed = result.changed;
      if (this.nonforcingPinned) return;
      this.uncertainCommands.delete(selected);
      this.lastError = undefined;
      if (changed > 0) {
        const changedHook = this.options.changed;
        if (this.nonforcingPinned) return;
        if (changedHook?.call(this.options) !== undefined) this.nonforcingUnknown = true;
      }
    } catch (error) {
      failed = true;
      if (this.nonforcingPinned) {
        this.nonforcingUnknown = true;
        if (command) this.uncertainCommands.set(selected, {commandId, command});
        return;
      }
      if (
        command &&
        (wasUncertain || committed || stateProcessErrorCode(error) === "STATE_OUTCOME_UNKNOWN")
      ) {
        this.uncertainCommands.set(selected, { commandId, command });
      } else {
        this.uncertainCommands.delete(selected);
      }
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.pending = false;
      this.pendingCommand = undefined;
    }
    const observation = {
      slice: selected,
      startedAt,
      durationMs: Math.max(0, performance.now() - started),
      changed,
      failed,
      deferred: false
    };
    return this.record(observation);
  }

  diagnostics(): readonly StateMaintenanceObservation[] {
    return this.observations;
  }

  close(): void {
    if (this.nonforcingPinned) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  pinNonforcingShutdown(): true {
    if (this.nonforcingPinned) return true;
    this.nonforcingUnknown ||= this.closed;
    this.nonforcingPinned = true;
    if (this.pendingCommand) {
      const {slice, commandId, command} = this.pendingCommand;
      this.uncertainCommands.set(slice, {commandId, command});
    }
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return true;
  }

  observeNonforcingExit(): ShutdownResult {
    if (!this.nonforcingPinned || this.nonforcingUnknown || this.uncertainCommands.size > 0)
      return shutdownResult("uncertain");
    return this.pending ? shutdownResult("timeout", 1) : shutdownResult("exited");
  }

  private record(observation: StateMaintenanceObservation): StateMaintenanceObservation {
    this.observations.push(observation);
    if (this.observations.length > 120) this.observations.shift();
    return observation;
  }
}

function defaultMaintenanceCommand(slice: StateMaintenanceSlice): OperationalStateCommand {
  if (slice === "jobs") {
    throw new Error("STATE_JOB_RETENTION_PLAN_REQUIRED: Job retention requires a bounded registry plan.");
  }
  return { operation: "maintain", slice };
}

function stateProcessErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
