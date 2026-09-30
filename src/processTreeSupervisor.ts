import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { JsonRpcProcessIdentity } from "./jsonRpcProcess.js";
import { decodeUtf8Strict } from "./textIntegrity.js";
import { boundedShutdown, shutdownResult, type ShutdownResult } from "./shutdown.js";

const PROCESS_TABLE_MAX_BYTES = 4 * 1024 * 1024;
// /bin/ps is normally quick, but the installed runtime has observed genuine
// 1.1-1.2 second probes under concurrent Codex work. Keep a finite bound while
// allowing a transient scheduler/process-table delay to settle.
const PROCESS_TABLE_TIMEOUT_MS = 3_000;
const PROCESS_TABLE_LATE_TIMER_TOLERANCE_MS = 250;
const PROCESS_TABLE_RESUME_GRACE_MS = 5_000;
const PROCESS_TABLE_SETTLE_MS = 100;
const OBSERVATION_DIAGNOSTIC_MAX_MS = 86_400_000;
const PROCESS_EXIT_POLL_MS = 100;
const MAX_SUPERVISED_PROCESSES_PER_TREE = 4_096;

export type SupervisedProcessIdentity = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  /** OS process birth stamp, compared before signaling retained descendants. */
  startedAt?: string;
};

export type SupervisedProcessTreeSnapshot = {
  root: JsonRpcProcessIdentity;
  processes: SupervisedProcessIdentity[];
  rootExited?: boolean;
  /** Observed ownership exceeded the bounded retained ledger; never absence proof. */
  incomplete?: true;
};

type ProcessTableEntry = SupervisedProcessIdentity & {
  state: string;
};

type SupervisedProcessTree = {
  root: JsonRpcProcessIdentity;
  captured: Map<number, SupervisedProcessIdentity>;
  ownedRoot: boolean;
  rootExited: boolean;
};

export type ProcessObservationFailure = {
  kind: "ps-timeout" | "ps-spawn" | "ps-exit" | "ps-output-limit" |
    "ps-output-invalid" | "ledger-limit" | "registration-lost" | "unknown";
  durationMs: number;
  timerLatenessMs: number;
  psExitCode: number | null;
  osCode: string | null;
};

class ProcessObservationError extends Error {
  constructor(readonly failure: ProcessObservationFailure) {
    super(`Process observation failed: ${failure.kind}.`);
  }
}

export function processObservationFailure(error: unknown): ProcessObservationFailure {
  return error instanceof ProcessObservationError ? error.failure : {
    kind: "unknown",
    durationMs: 0,
    timerLatenessMs: 0,
    psExitCode: null,
    osCode: null
  };
}

/**
 * Auxiliary, bounded ledger for owned worker descendants. Spawn/exit events
 * establish root lifetime; process-table snapshots add birth-verified children.
 * No observation result grants authority to fail a Job or kill the executor.
 * Detached children never observed before reparenting cannot be proven owned.
 */
export class SupervisedProcessTreeRegistry {
  private readonly trees = new Map<string, SupervisedProcessTree>();
  private tail: Promise<void> = Promise.resolve();
  private nonforcingEvidence?: Map<string, SupervisedProcessTree>;
  private forceOperations = 0;
  private nonforcingHistoryUncertain = false;
  private readonly incompleteTrees = new Set<string>();
  constructor(private readonly readTable: () => Promise<ProcessTableEntry[]> = readProcessTable) {}

  get size(): number {
    return (this.nonforcingEvidence ?? this.trees).size;
  }

  get capturedProcessCount(): number {
    return [...(this.nonforcingEvidence ?? this.trees).values()].reduce(
      (total, tree) => total + tree.captured.size,
      0
    );
  }

  has(identity: JsonRpcProcessIdentity): boolean {
    return this.trees.has(supervisedProcessKey(identity));
  }

  snapshots(): SupervisedProcessTreeSnapshot[] {
    return [...(this.nonforcingEvidence ?? this.trees)].map(([key,tree]) => ({
      root: { ...tree.root },
      rootExited: tree.rootExited,
      processes: [...tree.captured.values()].map((entry) => ({ ...entry })),
      ...(this.incompleteTrees.has(key) ? {incomplete:true as const} : {})
    }));
  }

  merge(snapshot: SupervisedProcessTreeSnapshot): void {
    const key = supervisedProcessKey(snapshot.root);
    const tree = this.trees.get(key);
    if (!tree) return;
    if (snapshot.incomplete === true || snapshot.processes.length > MAX_SUPERVISED_PROCESSES_PER_TREE) {
      this.incompleteTrees.add(key);
    }
    if (snapshot.processes.length > MAX_SUPERVISED_PROCESSES_PER_TREE) return;
    tree.rootExited ||= snapshot.rootExited === true;
    for (const entry of snapshot.processes) {
      if (!validProcessIdentity(entry)) continue;
      if (!tree.captured.has(entry.pid) &&
          tree.captured.size >= MAX_SUPERVISED_PROCESSES_PER_TREE) {
        this.incompleteTrees.add(key);continue;
      }
      const previous = tree.captured.get(entry.pid);
      tree.captured.set(entry.pid, {
        ...entry,
        startedAt: entry.startedAt ?? (previous?.processGroupId === entry.processGroupId
          ? previous.startedAt : undefined)
      });
    }
    this.retainObservedTree(supervisedProcessKey(snapshot.root), tree);
  }

  forget(identity: JsonRpcProcessIdentity): void {
    if (this.nonforcingEvidence || this.incompleteTrees.has(supervisedProcessKey(identity))) return;
    this.trees.delete(supervisedProcessKey(identity));
    this.incompleteTrees.delete(supervisedProcessKey(identity));
  }

  remember(identity: JsonRpcProcessIdentity, ownedRoot = false): void {
    validateRootIdentity(identity);
    const key = supervisedProcessKey(identity);
    if (this.trees.has(key)) return;
    this.trees.set(key, { root: { ...identity }, ownedRoot, rootExited: false,
      captured: new Map([[identity.pid, { pid: identity.pid, parentPid: 0,
        processGroupId: identity.processGroupId ?? identity.pid }]]) });
    if (this.nonforcingEvidence) this.nonforcingEvidence.set(key, cloneTree(this.trees.get(key)!));
  }

  markExited(identity: JsonRpcProcessIdentity): void {
    const tree = this.trees.get(supervisedProcessKey(identity));
    if (tree) { tree.rootExited = true; tree.ownedRoot = false; }
    const retained = this.nonforcingEvidence?.get(supervisedProcessKey(identity));
    if (retained) { retained.rootExited = true; retained.ownedRoot = false; }
  }

  register(identity: JsonRpcProcessIdentity): Promise<void> {
    validateRootIdentity(identity);
    const key = supervisedProcessKey(identity);
    this.remember(identity, true);
    return this.enqueue(async () => {
      if (process.platform === "win32") return;
      const tree = this.trees.get(key);
      if (!tree) return;
      const startedAt = performance.now();
      try {
        const rows = await this.readTable();
        this.observeAndRetain(key, tree, rows);
        const root = rows.find((entry) => entry.pid === identity.pid);
        if (!root || root.processGroupId !== identity.processGroupId || isZombie(root)) {
          throw new ProcessObservationError({
            kind: "registration-lost", durationMs: 0, timerLatenessMs: 0,
            psExitCode: null, osCode: null
          });
        }
      } catch (error) {
        throw withObservationDuration(error, startedAt);
      }
    });
  }

  refresh(): Promise<void> {
    if (this.trees.size === 0 || process.platform === "win32") return Promise.resolve();
    return this.enqueue(async () => {
      if (this.trees.size === 0) return;
      const startedAt = performance.now();
      try {
        const rows = await this.readTable();
        let failure: {error:unknown}|undefined;
        for (const [key, tree] of this.trees) {
          try {this.observeAndRetain(key, tree, rows);} catch(error) {failure ??= {error};}
        }
        if(failure) throw failure.error;
      } catch (error) {
        throw withObservationDuration(error, startedAt);
      }
    });
  }

  release(identity: JsonRpcProcessIdentity, graceMs: number): Promise<boolean> {
    const key = supervisedProcessKey(identity);
    return this.enqueue(async () => {
      if (this.nonforcingEvidence) {
        const retained = this.nonforcingEvidence.get(key);
        return retained ? (await this.observeRetainedTrees([retained])).exited : false;
      }
      const tree = this.trees.get(key);
      if (!tree) return true;
      this.forceOperations++;
      try {
        const exited = await terminateTree(tree, graceMs, this.readTable, () => !this.nonforcingEvidence);
        this.retainObservedTree(key, tree);
        if(this.incompleteTrees.has(key)) return false;
        if (exited && !this.nonforcingEvidence) {this.trees.delete(key);this.incompleteTrees.delete(key);}
        return exited && !this.nonforcingHistoryUncertain;
      } catch(error) {
        if(processObservationFailure(error).kind==="ledger-limit") this.incompleteTrees.add(key);
        throw error;
      } finally { this.forceOperations--; }
    });
  }

  cleanupAll(graceMs: number): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.nonforcingEvidence) {
        return (await this.observeRetainedTrees([...this.nonforcingEvidence.values()], true)).exited;
      }
      const entries = [...this.trees.entries()];
      if (entries.length === 0) return true;
      const results = await Promise.all(entries.map(async ([key, tree]) => {
        this.forceOperations++;
        try {
          const exited = await terminateTree(tree, graceMs, this.readTable, () => !this.nonforcingEvidence);
          this.retainObservedTree(key, tree);
          if(this.incompleteTrees.has(key)) return false;
          if (exited && !this.nonforcingEvidence) {this.trees.delete(key);this.incompleteTrees.delete(key);}
          return exited && !this.nonforcingHistoryUncertain;
        } catch(error) {
          if(processObservationFailure(error).kind==="ledger-limit") this.incompleteTrees.add(key);
          return false;
        } finally { this.forceOperations--; }
      }));
      return results.every(Boolean) && this.trees.size === 0;
    });
  }

  /** Synchronous sticky fence; queued/default cleanup cannot escalate or erase
   * this retained ledger after explicit nonforcing shutdown starts. */
  pinNonforcingShutdown(): void {
    if (this.nonforcingEvidence) return;
    this.nonforcingHistoryUncertain = this.forceOperations > 0;
    this.nonforcingEvidence = new Map([...this.trees].map(([key, tree]) => [key, cloneTree(tree)]));
  }

  /** Read-only fresh process-table proof, not a worker/generation receipt.
   * Retains prior evidence and sends no worker signal. */
  observeNonforcingExit(timeoutMs = 6000): Promise<ShutdownResult> {
    return boundedShutdown(() => this.enqueue(async () => {
      if (!this.nonforcingEvidence) return shutdownResult("uncertain");
      return this.observeRetainedTrees([...this.nonforcingEvidence.values()], true);
    }), timeoutMs);
  }

  private retainObservedTree(key: string, tree: SupervisedProcessTree): void {
    const retained = this.nonforcingEvidence?.get(key);
    if (!retained) return;
    for (const [pid, entry] of tree.captured) {
      const previous = retained.captured.get(pid);
      if(!previous && retained.captured.size>=MAX_SUPERVISED_PROCESSES_PER_TREE) {
        this.incompleteTrees.add(key);continue;
      }
      if (!previous || previous.processGroupId === entry.processGroupId && previous.startedAt === undefined) {
        retained.captured.set(pid, { ...entry });
      }
    }
  }

  private observeAndRetain(key: string, tree: SupervisedProcessTree, rows: readonly ProcessTableEntry[]): void {
    try { observeTree(tree, rows); }
    catch(error) {this.incompleteTrees.add(key);throw error;}
    finally {this.retainObservedTree(key, tree);}
  }

  private async observeRetainedTrees(trees: readonly SupervisedProcessTree[], all = false): Promise<ShutdownResult> {
    if (this.nonforcingHistoryUncertain || process.platform === "win32") return shutdownResult("uncertain");
    if (trees.length === 0) return shutdownResult("exited");
    const rows = await this.readTable();
    const survivors = new Set<number>();
    const changed = new Set<number>();
    let unknown = all && this.nonforcingEvidence?.size !== trees.length;
    for (const retained of trees) {
      const key=supervisedProcessKey(retained.root);
      const observedTree = cloneTree(retained);
      try {this.observeAndRetain(key,observedTree,rows);} catch {unknown=true;}
      unknown ||= this.incompleteTrees.has(key);
      for (const [pid, entry] of retained.captured) {
        const observed = rows.find(row => row.pid === pid);
        if (!observed || isZombie(observed)) {
          if (pid === retained.root.pid && !retained.rootExited && entry.startedAt === undefined) unknown = true;
          continue;
        }
        if (entry.processGroupId !== observed.processGroupId || entry.startedAt !== undefined &&
            observed.startedAt !== undefined && entry.startedAt !== observed.startedAt) changed.add(pid);
        else if (entry.startedAt === undefined || observed.startedAt === undefined) unknown = true;
      }
      for (const row of rows) {
        if (isZombie(row)) continue;
        const captured = observedTree.captured.get(row.pid);
        if (captured?.processGroupId === row.processGroupId && captured.startedAt !== undefined &&
            captured.startedAt === row.startedAt) survivors.add(row.pid);
        else if (row.processGroupId === retained.root.processGroupId || retained.captured.has(row.pid)) {
          survivors.add(row.pid);unknown = true;
        }
      }
    }
    return shutdownResult(unknown || changed.size ? "uncertain" : survivors.size ? "timeout" : "exited",
      survivors.size, 0, changed.size);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function cloneTree(tree: SupervisedProcessTree): SupervisedProcessTree {
  return { root: { ...tree.root }, ownedRoot: tree.ownedRoot, rootExited: tree.rootExited,
    captured: new Map([...tree.captured].map(([pid, entry]) => [pid, { ...entry }])) };
}

function withObservationDuration(error: unknown, startedAt: number): ProcessObservationError {
  const failure = processObservationFailure(error);
  if (failure.kind.startsWith("ps-") && error instanceof ProcessObservationError) return error;
  return new ProcessObservationError({
    ...failure,
    durationMs: boundedObservationMs(performance.now() - startedAt)
  });
}

export function supervisedProcessKey(identity: JsonRpcProcessIdentity): string {
  return `${identity.pid}:${identity.processGroupId ?? "process"}`;
}

async function terminateTree(
  tree: SupervisedProcessTree,
  graceMs: number,
  readTable: () => Promise<ProcessTableEntry[]> = readProcessTable,
  mayEscalate: () => boolean = () => true
): Promise<boolean> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error("Invalid supervised process termination grace period.");
  }
  if (process.platform === "win32") {
    if (!processAlive(tree.root.pid)) return true;
    signalPid(tree.root.pid, "SIGTERM");
    if (await waitForPidExit(tree.root.pid, graceMs)) return true;
    if (mayEscalate()) signalPid(tree.root.pid, "SIGKILL");
    return waitForPidExit(tree.root.pid, graceMs);
  }

  let rows = await readTable();
  observeTree(tree, rows);
  let running = runningTreeProcesses(tree, rows);
  if (running.length === 0) {
    // A live retained orphan with a missing birth stamp is not verified exit.
    return !hasPotentialLiveOwner(tree, rows);
  }
  signalTreeProcesses(running, rows, "SIGTERM");
  let observed = await waitForTreeExit(tree, graceMs, readTable);
  running = observed.running;
  if (running.length === 0) return !hasPotentialLiveOwner(tree, observed.rows);
  rows = await readTable();
  observeTree(tree, rows);
  running = runningTreeProcesses(tree, rows);
  signalTreeProcesses(running, rows, "SIGKILL", mayEscalate);
  observed = await waitForTreeExit(tree, graceMs, readTable);
  return observed.running.length === 0 && !hasPotentialLiveOwner(tree, observed.rows);
}

function hasPotentialLiveOwner(
  tree: SupervisedProcessTree,
  rows: readonly ProcessTableEntry[]
): boolean {
  return rows.some(row => {
    if (isZombie(row)) return false;
    if (row.processGroupId === tree.root.processGroupId) return true;
    const captured = tree.captured.get(row.pid);
    return captured?.processGroupId === row.processGroupId &&
      (captured.startedAt === undefined || row.startedAt === undefined);
  });
}

function observeTree(
  tree: SupervisedProcessTree,
  rows: readonly ProcessTableEntry[]
): void {
  const current = new Map(rows.map((entry) => [entry.pid, entry] as const));
  // A successful process-table read is a complete snapshot. Reclaim exited
  // or reused PIDs before applying the live-tree bound. Keep every verified
  // orphan that still appears in this snapshot, even if its root has exited.
  for (const [pid, captured] of tree.captured) {
    const observed = current.get(pid);
    if (!observed || isZombie(observed) ||
        observed.processGroupId !== captured.processGroupId ||
        (captured.startedAt !== undefined && observed.startedAt !== undefined &&
         observed.startedAt !== captured.startedAt)) {
      tree.captured.delete(pid);
    }
  }
  const children = new Map<number, ProcessTableEntry[]>();
  for (const row of rows) {
    if (isZombie(row)) continue;
    const entries = children.get(row.parentPid) || [];
    entries.push(row);
    children.set(row.parentPid, entries);
  }

  const pending: number[] = [];
  const ownedGroups = new Set<number>();
  for (const captured of tree.captured.values()) {
    const observed = current.get(captured.pid);
    const ownedLiveRoot = captured.pid === tree.root.pid && tree.ownedRoot && !tree.rootExited;
    if (observed && observed.processGroupId === captured.processGroupId && !isZombie(observed) &&
        (ownedLiveRoot || captured.startedAt !== undefined && captured.startedAt === observed.startedAt)) {
      pending.push(observed.pid);
      ownedGroups.add(observed.processGroupId);
    }
  }

  // Only a currently verified member establishes group ownership. A stored
  // numeric PGID alone is not authority after PID/PGID reuse.
  for (const row of rows) {
    if (!isZombie(row) && ownedGroups.has(row.processGroupId)) pending.push(row.pid);
  }

  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const row = current.get(pid);
    if (!row || isZombie(row)) continue;
    if (!tree.captured.has(row.pid) &&
        tree.captured.size >= MAX_SUPERVISED_PROCESSES_PER_TREE) {
      throw new ProcessObservationError({
        kind: "ledger-limit", durationMs: 0, timerLatenessMs: 0,
        psExitCode: null, osCode: null
      });
    }
    const previous = tree.captured.get(row.pid);
    tree.captured.set(row.pid, {
      pid: row.pid,
      parentPid: row.parentPid,
      processGroupId: row.processGroupId,
      // A missing birth stamp cannot replace an earlier verified identity.
      startedAt: row.startedAt ?? (previous?.processGroupId === row.processGroupId
        ? previous.startedAt : undefined)
    });
    if (!ownedGroups.has(row.processGroupId)) {
      ownedGroups.add(row.processGroupId);
      for (const candidate of rows) {
        if (!isZombie(candidate) && candidate.processGroupId === row.processGroupId) {
          pending.push(candidate.pid);
        }
      }
    }
    for (const child of children.get(row.pid) || []) pending.push(child.pid);
  }
}

function runningTreeProcesses(
  tree: SupervisedProcessTree,
  rows: readonly ProcessTableEntry[]
): ProcessTableEntry[] {
  observeTree(tree, rows);
  return rows.filter((row) => {
    if (isZombie(row)) return false;
    const captured = tree.captured.get(row.pid);
    return captured?.processGroupId === row.processGroupId &&
      captured.startedAt !== undefined && captured.startedAt === row.startedAt;
  });
}

async function waitForTreeExit(
  tree: SupervisedProcessTree,
  timeoutMs: number,
  readTable: () => Promise<ProcessTableEntry[]>
): Promise<{ running: ProcessTableEntry[]; rows: ProcessTableEntry[] }> {
  const deadline = Date.now() + timeoutMs;
  let running: ProcessTableEntry[] = [];
  do {
    const rows = await readTable();
    running = runningTreeProcesses(tree, rows);
    if (running.length === 0 || Date.now() >= deadline) return { running, rows };
    await delay(PROCESS_EXIT_POLL_MS);
  } while (true);
}

function signalTreeProcesses(
  running: readonly ProcessTableEntry[],
  _rows: readonly ProcessTableEntry[],
  signal: NodeJS.Signals,
  mayEscalate: () => boolean = () => true
): void {
  // Signal only birth-verified PIDs. A remembered numeric process group may
  // have gained unrelated members; group-wide signaling would include them.
  for (const entry of running) {
    if (signal === "SIGKILL" && !mayEscalate()) return;
    signalPid(entry.pid, signal);
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) {
    throw new Error(`Refusing to signal unsafe supervised process ${pid}.`);
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error) && !isPermissionDenied(error)) throw error;
  }
}

/** @internal Exported for bounded probe and suspend/resume regressions. */
export function readProcessTable(
  spawnProbe: () => ChildProcess = () =>
    spawn("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"]
    })
): Promise<ProcessTableEntry[]> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let child;
    try {
      child = spawnProbe();
    } catch (error) {
      reject(new ProcessObservationError({
        kind: "ps-spawn", durationMs: boundedObservationMs(performance.now() - startedAt),
        timerLatenessMs: 0, psExitCode: null, osCode: safeOsCode(error)
      }));
      return;
    }
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let timerLatenessMs = 0;
    let expectedTimeoutAt = performance.now() + PROCESS_TABLE_TIMEOUT_MS;
    let stage: "initial" | "settle" | "resume" = "initial";
    let timeout: NodeJS.Timeout;
    const failure = (
      kind: ProcessObservationFailure["kind"],
      psExitCode: number | null = null,
      osCode: string | null = null
    ) => new ProcessObservationError({
      kind,
      durationMs: boundedObservationMs(performance.now() - startedAt),
      timerLatenessMs,
      psExitCode,
      osCode
    });
    const schedule = (ms: number) => {
      expectedTimeoutAt = performance.now() + ms;
      timeout = setTimeout(onTimeout, ms);
      timeout.unref();
    };
    const onTimeout = () => {
      timerLatenessMs = Math.max(timerLatenessMs,
        boundedObservationMs(performance.now() - expectedTimeoutAt));
      if (stage !== "resume" &&
          timerLatenessMs > PROCESS_TABLE_LATE_TIMER_TOLERANCE_MS) {
        // /bin/ps and its supervisor can both be suspended with the machine.
        // A late timer firing on wake is not proof that process observation
        // failed. Give this same bounded probe a short post-resume interval.
        stage = "resume";
        schedule(PROCESS_TABLE_RESUME_GRACE_MS);
        return;
      }
      if (stage === "initial") {
        // A completed ps may have a queued close event behind this timer when
        // the owner event loop resumes near the original deadline.
        stage = "settle";
        schedule(PROCESS_TABLE_SETTLE_MS);
        return;
      }
      timedOut = true;
      child.kill("SIGKILL");
      reject(failure("ps-timeout"));
    };
    schedule(PROCESS_TABLE_TIMEOUT_MS);
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > PROCESS_TABLE_MAX_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        reject(failure("ps-output-limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture([], chunk));
    child.once("error", error => {
      clearTimeout(timeout);
      reject(failure("ps-spawn", null, safeOsCode(error)));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(failure("ps-timeout"));
        return;
      }
      if (outputLimitExceeded) {
        reject(failure("ps-output-limit"));
        return;
      }
      if (code !== 0) {
        reject(failure("ps-exit", code));
        return;
      }
      try {
        const entries = decodeUtf8Strict(Buffer.concat(stdout), "Process table stdout")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split(/\s+/))
          .map(([pid, parentPid, processGroupId, state, ...birth]) => ({
            pid: Number(pid),
            parentPid: Number(parentPid),
            processGroupId: Number(processGroupId),
            state: state || "",
            startedAt: birth.length ? birth.join(" ") : undefined
          }));
        if (entries.length === 0 || !entries.every((entry) =>
            Number.isSafeInteger(entry.pid) && entry.pid > 0 &&
            Number.isSafeInteger(entry.parentPid) && entry.parentPid >= 0 &&
            Number.isSafeInteger(entry.processGroupId) && entry.processGroupId > 0 &&
            typeof entry.state === "string" && entry.state.length > 0 &&
            typeof entry.startedAt === "string" && entry.startedAt.length > 0
          )) throw new Error("Invalid process table rows.");
        resolve(entries);
      } catch {
        reject(failure("ps-output-invalid"));
      }
    });
  });
}

function safeOsCode(error: unknown): string | null {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,24}$/u.test(code) ? code : null;
}

function boundedObservationMs(durationMs: number): number {
  return Math.min(OBSERVATION_DIAGNOSTIC_MAX_MS, Math.max(0, Math.round(durationMs)));
}

function validateRootIdentity(identity: JsonRpcProcessIdentity): void {
  if (
    !Number.isSafeInteger(identity.pid) || identity.pid < 2 ||
    (identity.processGroupId !== null &&
      (!Number.isSafeInteger(identity.processGroupId) || identity.processGroupId < 2))
  ) {
    throw new Error("Invalid supervised root process identity.");
  }
}

function validProcessIdentity(identity: SupervisedProcessIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid >= 2 &&
    Number.isSafeInteger(identity.parentPid) && identity.parentPid >= 0 &&
    Number.isSafeInteger(identity.processGroupId) && identity.processGroupId >= 2;
}

function isZombie(entry: ProcessTableEntry): boolean {
  return entry.state.startsWith("Z");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_EXIT_POLL_MS);
  } while (true);
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as NodeJS.ErrnoException).code === "EPERM";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
