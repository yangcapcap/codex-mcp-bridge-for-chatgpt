import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertPrivateFile,
  readPrivateFile,
  writePrivateFileAtomic
} from "./managed-file.mjs";
import {
  assertJsonTextIntegrity,
  assertWellFormedUnicode,
  decodeUtf8Strict,
  parseJsonUtf8Strict
} from "./text-integrity.mjs";

export const TUNNEL_PROFILE_METADATA_VERSION = 1;

export function defaultTunnelProfileMetadataFile(runtimeEnvFile, profile) {
  const digest = createHash("sha256").update(profile).digest("hex").slice(0, 24);
  return resolve(dirname(runtimeEnvFile), "profiles", `${digest}.json`);
}

export function expectedTunnelProfileIdentity(values) {
  return {
    version: TUNNEL_PROFILE_METADATA_VERSION,
    profile: values.profile,
    tunnelId: values.tunnelId,
    transport: values.transport,
    authentication: values.authentication || "noauth",
    endpoint: values.endpoint,
    runtimeBuildId: values.runtimeBuildId,
    runtimeRoot: resolve(values.runtimeRoot),
    nodeExecutable: resolve(values.nodeExecutable),
    tunnelClient: values.tunnelClient,
    tunnelClientVersion: values.tunnelClientVersion
  };
}

export function inspectReusableTunnelProfile({
  tunnelClient,
  profile,
  environment,
  cwd,
  metadataFile,
  expected,
  run = spawnSync
}) {
  const inventory = listProfiles(tunnelClient, environment, cwd, run);
  const matches = inventory.filter((entry) => entry.name === profile);
  if (matches.length !== 1) {
    return {
      reusable: false,
      reason: matches.length === 0 ? "profile is absent" : "profile name is ambiguous"
    };
  }
  const profilePath = matches[0].path;
  try {
    if (!existsSync(metadataFile)) {
      return { reusable: false, reason: "managed metadata is absent", profilePath };
    }
    assertPrivateFile(metadataFile);
    assertPrivateFile(profilePath);
    const metadata = parseJsonUtf8Strict(readPrivateFile(metadataFile), "Tunnel profile metadata");
    if (!sameIdentity(metadata.identity, expected)) {
      return { reusable: false, reason: "managed identity changed", profilePath };
    }
    const profileHash = sha256(readPrivateFile(profilePath));
    if (metadata.profileHash !== profileHash) {
      return { reusable: false, reason: "profile contents changed", profilePath };
    }
    return { reusable: true, reason: null, profilePath };
  } catch (error) {
    return {
      reusable: false,
      reason: error instanceof Error ? error.message : String(error),
      profilePath
    };
  }
}

export function recordTunnelProfileMetadata({
  tunnelClient,
  profile,
  environment,
  cwd,
  metadataFile,
  identity,
  run = spawnSync
}) {
  const inventory = listProfiles(tunnelClient, environment, cwd, run);
  const matches = inventory.filter((entry) => entry.name === profile);
  if (matches.length !== 1) {
    throw new Error("Managed tunnel profile could not be resolved uniquely after initialization.");
  }
  const profilePath = matches[0].path;
  assertPrivateFile(profilePath);
  const metadata = {
    identity,
    profileHash: sha256(readPrivateFile(profilePath)),
    recordedAt: new Date().toISOString()
  };
  writePrivateFileAtomic(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8"
  });
  return { profilePath, metadataFile: resolve(metadataFile) };
}

export function readTunnelClientVersion(tunnelClient, environment, cwd, run = spawnSync) {
  const result = run(tunnelClient, ["--version"], {
    cwd,
    env: environment,
    timeout: 5_000
  });
  if (result.status !== 0) throw new Error("Could not read the tunnel-client version.");
  return processOutputText(result.stdout || result.stderr, "tunnel-client version").trim().slice(0, 500);
}

function listProfiles(tunnelClient, environment, cwd, run) {
  const result = run(tunnelClient, ["profiles", "list", "--json"], {
    cwd,
    env: environment,
    timeout: 10_000
  });
  if (result.status !== 0) {
    throw new Error("Could not inspect existing tunnel-client profiles.");
  }
  let parsed;
  try {
    parsed = parseProcessJson(result.stdout, "tunnel-client profile inventory", []);
  } catch {
    throw new Error("tunnel-client returned an invalid profile inventory.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("tunnel-client returned an invalid profile inventory.");
  }
  return parsed.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      typeof entry.path !== "string"
    ) {
      throw new Error("tunnel-client returned an invalid profile entry.");
    }
    return { name: entry.name, path: resolve(entry.path) };
  });
}

function processOutputText(value, field) {
  if (value instanceof Uint8Array) return decodeUtf8Strict(value, field);
  if (typeof value === "string") {
    assertWellFormedUnicode(value, field);
    return value;
  }
  return "";
}

function parseProcessJson(value, field, fallback) {
  if (value instanceof Uint8Array) {
    return parseJsonUtf8Strict(value.length === 0 ? Buffer.from(JSON.stringify(fallback)) : value, field);
  }
  const text = processOutputText(value, field) || JSON.stringify(fallback);
  const parsed = JSON.parse(text);
  assertJsonTextIntegrity(parsed, field);
  return parsed;
}

function sameIdentity(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
