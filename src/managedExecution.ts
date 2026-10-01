/** Protocol evidence ported from CoGate 128932c. No legacy pool, CLI, SDK or DB. */
/** Evidence for protocol-managed work only. Never infer process exit from prose,
 * output text, a PID disappearing, or the enclosing turn's status. */
type Item = Record<string, unknown> & { id: string; type: string };
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const item = (x: unknown): x is Item => record(x) && typeof x.id === "string" && !!x.id && typeof x.type === "string";
const passive = new Set(["userMessage", "agentMessage", "reasoning", "plan", "imageView", "sleep", "contextCompaction", "enteredReviewMode", "exitedReviewMode"]);
const executable = new Set(["commandExecution", "fileChange"]);
const durableItem = (value?: Item): Item | undefined => value ? { id: value.id, type: value.type,
  ...Object.fromEntries(["command", "cwd", "processId", "status", "exitCode"].filter(key => key in value).map(key => [key, value[key]])) } : undefined;

export class ManagedExecution {
  #items = new Map<string, { start?: Item; end?: Item }>();
  #sealed = false;
  #invalid = false;
  #revision = 0;
  #approvals = new Set<string>();
  #denied = new Set<string>();
  get version(): number { return this.#revision; }
  block(): void { this.#invalid = true; this.#revision++; }
  approval(id: string): void {
    if (this.#sealed || this.#approvals.has(id) || this.#denied.has(id)) this.block();
    this.#approvals.add(id); this.#revision++;
  }
  denyApproval(id: string): void {
    if (this.#sealed || !this.#approvals.delete(id)) this.block();
    this.#denied.add(id); this.#revision++;
  }

  observe(method: string, params: Record<string, unknown>): void {
    if (method === "item/started" || method === "item/completed") {
      this.#revision++;
      if (this.#sealed || !item(params.item)) { this.block(); return; }
      const value = structuredClone(params.item), previous = this.#items.get(value.id) || {};
      if (!passive.has(value.type) && !executable.has(value.type) && value.type !== "functionCallOutput") this.block();
      if (method === "item/started") {
        if (this.#denied.has(value.id) || previous.start || previous.end || (executable.has(value.type) && value.status !== "inProgress")) this.block();
        previous.start = value;
      } else {
        if (previous.end || (executable.has(value.type) && !previous.start && !this.#declined(value))) this.block();
        if (previous.start && !this.#sameIdentity(previous.start, value)) this.block();
        if (!this.#terminal(value)) this.block();
        previous.end = value;
      }
      this.#items.set(value.id, previous);
    } else if (method.startsWith("item/commandExecution/")) {
      const state = typeof params.itemId === "string" ? this.#items.get(params.itemId) : undefined;
      if (this.#sealed || !state?.start || state.end || state.start.type !== "commandExecution") this.block();
      // outputDelta and terminalInteraction are observations, never exit evidence.
      if (!["item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction"].includes(method)) this.block();
    } else if (method === "error" || method === "warning" || /background|termination/i.test(method)) this.block();
  }

  finish(turn: Record<string, unknown>): boolean {
    if (this.#sealed) this.block();
    this.#sealed = true;
    if (this.#approvals.size) this.block();
    if (typeof turn.status !== "string" || !["completed", "failed", "interrupted"].includes(turn.status) ||
        (turn.itemsView !== undefined && (typeof turn.itemsView !== "string" || !["full", "summary"].includes(turn.itemsView))) || !Array.isArray(turn.items)) this.block();
    const terminal = new Map<string, Item>();
    for (const value of Array.isArray(turn.items) ? turn.items : []) {
      if (!item(value) || terminal.has(value.id)) { this.block(); continue; }
      terminal.set(value.id, value);
      const observed = this.#items.get(value.id);
      if (!this.#terminal(value) || (executable.has(value.type) && ((!observed?.start && !this.#declined(value)) || !observed?.end))) this.block();
      if (observed?.end && !this.#sameTerminal(observed.end, value)) this.block();
    }
    for (const [id, observed] of this.#items) {
      if (!observed.end || (turn.itemsView !== "summary" && !terminal.has(id))) this.block();
    }
    return !this.#invalid;
  }
  get clean(): boolean { return this.#sealed && !this.#invalid; }

  /** Durable protocol evidence, independent of prunable Activity display history. */
  snapshot() {
    return structuredClone({ version: this.#revision, sealed: this.#sealed, invalid: this.#invalid, clean: this.clean,
      items: [...this.#items.entries()].map(([id, state]) => ({ id, start: durableItem(state.start), end: durableItem(state.end) })),
      approvals: [...this.#approvals], deniedApprovals: [...this.#denied] });
  }

  /** Recheck the durable ledger with the same rules used during execution. */
  static verifies(snapshot: ReturnType<ManagedExecution["snapshot"]> | undefined): boolean {
    if (!snapshot || snapshot.clean !== true || snapshot.sealed !== true || snapshot.invalid !== false ||
        !Array.isArray(snapshot.items) || !Array.isArray(snapshot.approvals) || snapshot.approvals.length ||
        !Array.isArray(snapshot.deniedApprovals)) return false;
    try {
      const replay = new ManagedExecution();
      for (const value of snapshot.items) if (value.start) replay.observe("item/started", { item: value.start });
      for (const id of snapshot.deniedApprovals) { replay.approval(id); replay.denyApproval(id); }
      for (const value of snapshot.items) if (value.end) replay.observe("item/completed", { item: value.end });
      return replay.finish({ status: "completed", itemsView: "summary", items: [] });
    } catch { return false; }
  }

  #sameIdentity(a: Item, b: Item): boolean {
    return a.type === b.type && (a.type !== "commandExecution" ||
      (a.command === b.command && a.cwd === b.cwd && (a.processId == null || a.processId === b.processId)));
  }
  #sameTerminal(a: Item, b: Item): boolean {
    return this.#sameIdentity(a, b) && a.status === b.status && a.exitCode === b.exitCode && a.processId === b.processId;
  }
  #terminal(value: Item): boolean {
    if (passive.has(value.type)) return true;
    if (executable.has(value.type) && this.#denied.has(value.id) && !this.#declined(value)) return false;
    if (value.type === "commandExecution") {
      if (this.#declined(value)) return true;
      return typeof value.command === "string" && typeof value.cwd === "string" &&
        typeof value.status === "string" && ["completed", "failed"].includes(value.status) && Number.isInteger(value.exitCode) &&
        (value.status !== "completed" || value.exitCode === 0);
    }
    if (value.type === "fileChange") return typeof value.status === "string" && ["completed", "failed", "declined"].includes(value.status);
    // 0.153.3 functionCallOutput has no execution status. It cannot establish
    // completion of code-mode cells or deferred tools. Unsupported output-only
    // execution retains the lease; V1 keeps the native shell host enabled with code_mode/code_mode_only off.
    return false;
  }
  #declined(value: Item): boolean {
    return this.#denied.has(value.id) && value.status === "declined" && value.exitCode == null && value.processId == null;
  }
}
