#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import type { BridgeHttpServer } from "./server.js";
import { PRODUCT_INFO } from "./productInfo.js";
import { startRuntimeCompanions } from "./runtimeCompanions.js";
import { createIsolatedHttpServer } from "./runtimeProcess.js";

if (process.platform === "darwin") {
  process.title = "Codex MCP Bridge Server";
}

const config = loadConfig();
let shuttingDown = false;
let server: BridgeHttpServer | undefined;
let companions: Awaited<ReturnType<typeof startRuntimeCompanions>> | undefined;

for (const warning of [...config.startupWarnings, ...config.developerStartupWarnings]) {
  console.warn(`warning: ${warning}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  void shutdown("startup failure", 1);
});

async function main(): Promise<void> {
  const createdServer = await createIsolatedHttpServer(config, {
    conformanceFixtures: process.argv.slice(2).includes("--conformance-fixtures")
  });
  server = createdServer;
  companions = await startRuntimeCompanions(config, createdServer.applicationService);
  if (shuttingDown) { await companions.close(); return; }
  await new Promise<void>((resolve, reject) => {
    createdServer.once("error", reject);
    createdServer.listen(config.port, config.host, () => {
      createdServer.removeListener("error", reject);
      resolve();
    });
  });
  const authHint = config.oauth ? "OAuth access token required" : config.token && !config.noAuth ? "Bearer token required" : "no auth";
  console.log(`${PRODUCT_INFO.displayName} listening on http://${config.host}:${config.port}/mcp (${authHint})`);
  console.log(`build: ${BRIDGE_BUILD_INFO.id} (${BRIDGE_BUILD_INFO.version})`);
}

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  for (const [name, close] of [
    ["companions", () => companions?.close()],
    ["HTTP server", () => server
      ? new Promise<void>((resolve, reject) => server?.close(error =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ? reject(error)
          : resolve()))
      : undefined]
  ] as const) {
    try { await close(); }
    catch (error) { code = 1; console.error(`${name} shutdown failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
