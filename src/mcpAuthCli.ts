#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAiMcpAuthorization, type OpenAiMcpAuthorizationConfig } from "./openaiMcpAuthorization.js";

async function privateFile(file: string) {
  if (!constants.O_NOFOLLOW || !process.getuid) throw new Error("Safe private-file ownership and symlink checks are unavailable on this platform.");
  // Open once without following a leaf symlink, then inspect/read that same
  // descriptor. A pathname replacement cannot bypass the ownership check.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
      throw new Error("Authorization configuration and key files must be private regular files owned by the operator.");
    }
    if (stat.size > 32_768) throw new Error("Authorization configuration exceeds the size limit.");
    const content = await handle.readFile("utf8");
    if (Buffer.byteLength(content) > 32_768) throw new Error("Authorization configuration exceeds the size limit.");
    return content;
  } finally { await handle.close(); }
}

export async function runMcpAuthCli(args: string[]) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log("Usage: node dist/mcpAuthCli.js --config <private-json-file>\n\nStarts an opt-in, loopback-only OpenAI/Bridge authorization service.\nThe config supplies exact issuer/resource/client callback, verified OpenAI\nregistration metadata, a connector client secret and an Ed25519 key file.\nPublic HTTPS hosting and ChatGPT connection are separate deployment steps.\nNo model calls or OpenAI token storage are performed.");
    return;
  }
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw new Error("Use --config <private-json-file>; this service never starts implicitly.");
  const configFile = path.resolve(args[1]);
  const raw = JSON.parse(await privateFile(configFile));
  if (!raw || typeof raw !== "object" || typeof raw.signingKeyFile !== "string") throw new Error("The private authorization config must specify a signing key file.");
  for (const port of [raw.authorizationPort, raw.callbackPort]) {
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) throw new Error("Authorization listener ports must be bounded integers.");
  }
  const key = await privateFile(path.resolve(path.dirname(configFile), raw.signingKeyFile));
  const config: OpenAiMcpAuthorizationConfig = { issuer: raw.issuer, resource: raw.resource, openaiClientId: raw.openaiClientId,
    hostId: raw.hostId, operatorIdentityHash: raw.operatorIdentityHash, connectorClient: raw.connectorClient, signingKeyPkcs8: key };
  const service = await createOpenAiMcpAuthorization(config);
  try {
    const addresses = await service.listen({ authorization: raw.authorizationPort, callback: raw.callbackPort });
    // Deliberately omit config, client secrets, registration metadata and private keys.
    console.log(JSON.stringify({ status: "listening_locally", authorizationBase: addresses.authorizationBase,
      callbackBase: addresses.callbackBase, publicHttpsConfiguredByThisCommand: false, modelRequests: 0 }));
    const stop = () => { void service.close(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } catch (error) { await service.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMcpAuthCli(process.argv.slice(2)).catch(() => {
    // Config/provider diagnostics can contain secrets; expose only a safe error.
    console.error("Bridge authorization service could not start. Check the private configuration and provider availability.");
    process.exitCode = 1;
  });
}
