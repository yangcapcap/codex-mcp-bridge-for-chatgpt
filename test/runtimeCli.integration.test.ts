import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { COMPANION_PROTOCOL_NAME, COMPANION_PROTOCOL_VERSION } from "../src/companionServer.js";

it.each(["cli", "stdio"])("starts native and remote app connections in the built %s entrypoint", async (entrypoint) => {
  const root = mkdtempSync(path.join(tmpdir(), "cb-cli-"));
  // A sparse child environment must not fall back to the operator's home or
  // Codex authentication. Keep all default discovery inside this fixture.
  const homes = Object.fromEntries(["home", "codex", "config", "cache", "data", "state"].map(name => {
    const directory = path.join(root, name);
    mkdirSync(directory, { mode: 0o700 });
    return [name, directory];
  }));
  const isolation = process.env.GATEWAY_VALIDATION_ROOT ? Object.fromEntries(
    ["GATEWAY_VALIDATION_ROOT", "GATEWAY_VALIDATION_SHORT_ROOT_TOKEN", "NODE_OPTIONS"]
      .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])
  ) : {};
  const socketPath = path.join(root, "run", "b.sock");
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve(process.env.CODEX_BRIDGE_TEST_RUNTIME_DIST || "dist", `${entrypoint}.js`)], {
    env: {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      HOME: homes.home, CODEX_HOME: homes.codex,
      XDG_CONFIG_HOME: homes.config, XDG_CACHE_HOME: homes.cache,
      XDG_DATA_HOME: homes.data, XDG_STATE_HOME: homes.state,
      ...isolation,
      CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
      CODEX_MCP_BRIDGE_PORT: String(port), CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false",
      CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
      CODEX_MCP_BRIDGE_COMPANION_SOCKET: socketPath,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"),
      CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const client = new Client(
    { name: "built-http-native", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  try {
    for (let count = 0; count < 100; count++) {
      const ready = entrypoint === "cli" ? output.includes("listening on http://") : output.includes("persistent stdio ready");
      if (ready && existsSync(socketPath)) break;
      if (child.exitCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(existsSync(socketPath), output).toBe(true);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    expect(await rpc(socketPath, "companion.hello")).toMatchObject({
      protocol: { name: COMPANION_PROTOCOL_NAME, version: COMPANION_PROTOCOL_VERSION }
    });
    expect(await rpc(socketPath, "remote.status")).toMatchObject({ enabled: false, listening: false });
    const native = await rpc(socketPath, "dashboard.snapshot", { enrich: false });
    expect(native).toMatchObject({ enrichment: { state: "structural" }, counts: { trackedConversations: 0 } });
    if (entrypoint === "cli") {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const card = await client.callTool({
        name: "codex_ui_read",
        arguments: { view: "dashboard", widgetInstanceId: randomUUID(), enrich: false }
      });
      expect(card.isError, JSON.stringify(card.content)).not.toBe(true);
      expect(card.structuredContent?.counts).toEqual(native.counts);
    }
    expect(await rpc(socketPath, "runtime.beginDrain")).toMatchObject({ acceptingNewJobs: false, activeJobs: 0, pendingAdmissions: 0 });
    expect(await rpc(socketPath, "runtime.cancelDrain")).toMatchObject({ acceptingNewJobs: true });
    child.kill("SIGTERM");
    expect(await exited, output).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  } finally {
    await client.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
    await exited;
    clearTimeout(force);
  }
}, 15000);

async function rpc(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setTimeout(5000, () => socket.destroy(new Error(`${method} timed out`)));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.end();
      const response = JSON.parse(buffer.split("\n")[0]);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    });
  });
}
