// The handle, rather than a caller-supplied PID, owns this opt-in decision.
// A concurrent/default cleanup cannot later escalate that same child handle.
const nonforcingChildren = new WeakSet();

export async function terminateManagedChildren(
  children,
  {
    interruptTimeoutMs = 10_000,
    terminateTimeoutMs = 3_000,
    killTimeoutMs = 2_000,
    allowSigkillEscalation = true
  } = {}
) {
  if (typeof allowSigkillEscalation !== "boolean" ||
      [interruptTimeoutMs, terminateTimeoutMs, killTimeoutMs].some(ms =>
        !Number.isSafeInteger(ms) || ms < 0 || ms > 60_000)) {
    throw new Error("SHUTDOWN_POLICY_INVALID");
  }
  let running = [...children].filter(isRunning);
  if (!allowSigkillEscalation) for (const child of running) nonforcingChildren.add(child);
  sendSignal(running, "SIGINT");
  running = await waitForChildren(running, interruptTimeoutMs);
  if (running.length > 0) {
    sendSignal(running, "SIGTERM");
    running = await waitForChildren(running, terminateTimeoutMs);
  }
  if (running.length > 0 && allowSigkillEscalation) {
    sendSignal(running, "SIGKILL");
    running = await waitForChildren(running, killTimeoutMs);
  }
  return { exited: running.length === 0, remaining: running };
}

function sendSignal(children, signal) {
  for (const child of children) {
    if (!isRunning(child)) continue;
    if (signal === "SIGKILL" && nonforcingChildren.has(child)) continue;
    try {
      child.kill(signal);
    } catch {
      // The exit observation below is authoritative.
    }
  }
}

function waitForChildren(children, timeoutMs) {
  const running = children.filter(isRunning);
  if (running.length === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const pending = new Set(running);
    const listeners = new Map();
    let timer;
    const finish = () => {
      if (timer) clearTimeout(timer);
      for (const [child, listener] of listeners) child.removeListener("exit", listener);
      resolve([...pending].filter(isRunning));
    };
    for (const child of running) {
      const listener = () => {
        pending.delete(child);
        if (pending.size === 0) finish();
      };
      listeners.set(child, listener);
      child.once("exit", listener);
      if (!isRunning(child)) pending.delete(child);
    }
    timer = setTimeout(finish, Math.max(0, timeoutMs));
    if (pending.size === 0) finish();
  });
}

function isRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}
