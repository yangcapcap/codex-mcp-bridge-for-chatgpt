import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";

// Deliberately unapproved fixture claims, never a conversion or approval receipt.
const claims = ["conversion-marker", "conversion-origin", "active-control"] as const;
for (const claim of claims) it.each(["cli", "stdio"])(
  `built %s rejects unapproved ${claim} before ownership or persistence writes`, async entrypoint => {
    const root = mkdtempSync(path.join(tmpdir(), "cb-deny-"));
    const file = path.join(root, "state.sqlite");
    const store = new BridgeStateStore({ file });
    store.close();
    const database = new Database(file);
    try {
      database.pragma("journal_mode=WAL");
      if (claim === "conversion-marker") {
        database.prepare("INSERT INTO bridge_meta(key,value) VALUES('cogate_lineage_conversion_v1',?)").run(randomUUID());
      } else if (claim === "conversion-origin") {
        expect(database.prepare("UPDATE bridge_meta SET value=? WHERE key='state_schema_origin'").run(
          JSON.stringify({ kind: "lineage-conversion", format: "cogate-unified-origin/v1" })
        ).changes).toBe(1);
      } else database.prepare("UPDATE workspace_control SET mode='enabled',revision=revision+1").run();
      const directories = Object.fromEntries(["home", "codex", "config", "cache", "data", "state"].map(name => {
        const directory = path.join(root, name); mkdirSync(directory, { mode: 0o700 }); return [name, directory];
      }));
      const entries = readdirSync(root).sort();
      // SQLite readers may change shared-memory lock bytes. The main DB, WAL and
      // durable lifecycle files must stay byte-identical, with no new sidecars.
      const durable = entries.filter(name => name.startsWith("state.sqlite") && !name.endsWith("-shm"));
      const before = new Map(durable.map(name => [name, readFileSync(path.join(root, name))]));
      const owners = database.prepare("SELECT * FROM bridge_instances ORDER BY instance_id").all();
      const markers = process.env.GATEWAY_VALIDATION_ROOT ? Object.fromEntries(
        ["GATEWAY_VALIDATION_ROOT", "GATEWAY_VALIDATION_SHORT_ROOT_TOKEN", "NODE_OPTIONS"]
          .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])
      ) : {};
      const child = spawn(process.execPath, [path.resolve(process.env.CODEX_BRIDGE_TEST_RUNTIME_DIST || "dist", `${entrypoint}.js`)], {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
          HOME: directories.home, CODEX_HOME: directories.codex,
          XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache,
          XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state,
          ...markers,
          CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_HOST: "127.0.0.1", CODEX_MCP_BRIDGE_PORT: "8765",
          CODEX_MCP_BRIDGE_CODEX: "/usr/bin/false", CODEX_MCP_BRIDGE_RUNTIME_HOME: path.join(root, "runtime"),
          CODEX_MCP_BRIDGE_COMPANION_SOCKET: path.join(root, "run", "b.sock"),
          CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file,
          CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: path.join(root, "models.json") },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(await exited, output).toEqual({ code: 1, signal: null });
      expect(output).toContain("COGATE_STATE_ACTIVATION_UNAVAILABLE");
      expect(output).not.toMatch(/listening on http:\/\/|persistent stdio ready/);
      expect(database.prepare("SELECT * FROM bridge_instances ORDER BY instance_id").all()).toEqual(owners);
      expect(readdirSync(root).sort()).toEqual(entries);
      for (const [name, bytes] of before) expect(readFileSync(path.join(root, name)), name).toEqual(bytes);
    } finally { database.close(); }
  }, 15_000
);
