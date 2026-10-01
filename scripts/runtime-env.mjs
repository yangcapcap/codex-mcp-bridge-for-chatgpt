import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { decodeUtf8Strict } from "./text-integrity.mjs";
import { authProfileHome, authSelectionRoot, desiredAuthSelection, knownExternalHome, readAuthSelection } from "./auth-selection.mjs";

const RUNTIME_CONFIG_DIRECTORY = "codex-mcp-bridge";
const RUNTIME_ENV_FILENAME = ".env";
const MCP_OAUTH_NAMES = ["ISSUER", "RESOURCE", "RESOURCE_METADATA_URL", "JWKS_URI", "OPERATOR_SUBJECT"];

/** Only MCP login configuration; never Codex execution authentication. */
export function mcpOAuthRequested(environment) {
  return MCP_OAUTH_NAMES.some(name => Boolean(
    environment[`CODEX_MCP_BRIDGE_OAUTH_${name}`] || environment[`CODEX_GPT_BRIDGE_OAUTH_${name}`]
  ));
}

export function mcpOAuthEnvironment(environment) {
  const selected = {};
  for (const prefix of ["CODEX_MCP_BRIDGE_", "CODEX_GPT_BRIDGE_"]) {
    for (const suffix of [...MCP_OAUTH_NAMES.map(name => `OAUTH_${name}`), "TOKEN"]) {
      const key = prefix + suffix;
      if (environment[key] !== undefined) selected[key] = environment[key];
    }
  }
  return selected;
}
export const RUNTIME_ENV_MANAGED_KEYS = [
  "CONTROL_PLANE_API_KEY",
  "CONTROL_PLANE_TUNNEL_ID",
  "CODEX_MCP_BRIDGE_DEFAULT_BACKEND",
  "CODEX_MCP_BRIDGE_ALLOW_WRITE",
  "CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS"
];

// The same Codex child settings are projected for the native helper and the
// launcher. Tunnel, billing, and API-key credentials are deliberately absent.
export const CODEX_CHILD_ENV_KEYS = Object.freeze([
  "CODEX_HOME", "CODEX_MCP_BRIDGE_RUNTIME_HOME", "CODEX_MCP_BRIDGE_AUTH_DISCONNECTED", "CODEX_MCP_BRIDGE_AUTH_SOURCE",
  "CODEX_MCP_BRIDGE_AUTH_GENERATION",
  "CODEX_MCP_BRIDGE_CODEX", "CODEX_GPT_BRIDGE_CODEX",
  "XDG_CONFIG_HOME", "XDG_STATE_HOME",
  "LANG", "LC_ALL", "LC_CTYPE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "SSL_CERT_DIR", "SSL_CERT_FILE"
]);

export const CODEX_APPLIED_ENV_KEYS = Object.freeze([
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", ...CODEX_CHILD_ENV_KEYS
]);

/** The launcher's private status retains only the Codex child environment it applied. */
export function codexAppliedEnvironment(environment) {
  const applied = {};
  for (const name of CODEX_APPLIED_ENV_KEYS) {
    if (typeof environment[name] === "string") applied[name] = environment[name];
  }
  return applied;
}

/**
 * Process values win over private-file values, including across the current
 * and legacy command names. A legacy command is normalized to the current
 * name so every consumer observes the same effective override.
 */
export function codexChildEnvironment(filePath, inherited = process.env) {
  const fromFile = filePath ? readRuntimeEnvSubset(filePath, CODEX_CHILD_ENV_KEYS) : {};
  const projected = {};
  for (const name of CODEX_CHILD_ENV_KEYS) {
    if (name === "CODEX_MCP_BRIDGE_CODEX" || name === "CODEX_GPT_BRIDGE_CODEX") continue;
    const value = inherited[name] ?? fromFile[name];
    if (value !== undefined) projected[name] = value;
  }
  const command = inherited.CODEX_MCP_BRIDGE_CODEX || inherited.CODEX_GPT_BRIDGE_CODEX ||
    fromFile.CODEX_MCP_BRIDGE_CODEX || fromFile.CODEX_GPT_BRIDGE_CODEX;
  if (command) projected.CODEX_MCP_BRIDGE_CODEX = command;
  delete projected.CODEX_MCP_BRIDGE_AUTH_DISCONNECTED;
  delete projected.CODEX_MCP_BRIDGE_AUTH_SOURCE;
  delete projected.CODEX_MCP_BRIDGE_AUTH_GENERATION;
  if (["shared", "external", "bridge-chatgpt", "bridge-api", "disconnected"].includes(inherited.CODEX_MCP_BRIDGE_AUTH_SOURCE)) {
    projected.CODEX_MCP_BRIDGE_AUTH_SOURCE = inherited.CODEX_MCP_BRIDGE_AUTH_SOURCE;
    projected.CODEX_MCP_BRIDGE_AUTH_GENERATION = inherited.CODEX_MCP_BRIDGE_AUTH_GENERATION || "0";
    if (inherited.CODEX_MCP_BRIDGE_AUTH_SOURCE === "disconnected") projected.CODEX_MCP_BRIDGE_AUTH_DISCONNECTED = "1";
    return projected;
  }
  const explicitHome = inherited.CODEX_HOME !== undefined || fromFile.CODEX_HOME !== undefined;
  const { connection, generation } = explicitHome
    ? { connection: { kind: "shared" }, generation: 0 }
    : desiredAuthSelection({ ...inherited, ...projected });
  projected.CODEX_MCP_BRIDGE_AUTH_SOURCE = explicitHome ? "shared" : connection.kind;
  projected.CODEX_MCP_BRIDGE_AUTH_GENERATION = String(explicitHome ? 0 : generation);
  if (connection.kind !== "shared" && !explicitHome) {
    if (connection.kind === "disconnected") projected.CODEX_MCP_BRIDGE_AUTH_DISCONNECTED = "1";
    else if (connection.kind === "external") {
      const root = authSelectionRoot({ ...inherited, ...projected });
      projected.CODEX_HOME = knownExternalHome(readAuthSelection({ CODEX_MCP_BRIDGE_RUNTIME_HOME: root }), connection.homeId);
    } else projected.CODEX_HOME = authProfileHome(authSelectionRoot({ ...inherited, ...projected }), connection.profileId);
  }
  return projected;
}

/** Keep launcher/tunnel credentials out of selected Codex processes. */
export function codexProcessEnvironment(environment) {
  const projected = { ...environment };
  delete projected.CODEX_MCP_BRIDGE_AUTH_ACTIVATION_ID;
  const sealedSource = projected.CODEX_MCP_BRIDGE_AUTH_SOURCE;
  const explicitHome = Boolean(projected.CODEX_HOME) && !sealedSource;
  const needsSaved = !sealedSource && !explicitHome ||
    (["external", "bridge-chatgpt", "bridge-api"].includes(sealedSource)) && !projected.CODEX_HOME;
  const desired = needsSaved ? desiredAuthSelection(projected) : null;
  const connection = sealedSource || (explicitHome ? "shared" : desired.connection.kind);
  projected.CODEX_MCP_BRIDGE_AUTH_SOURCE = connection;
  projected.CODEX_MCP_BRIDGE_AUTH_GENERATION ||= String(explicitHome ? 0 : desired?.generation || 0);
  if (!projected.CODEX_HOME && connection === "external") {
    const selected = desired.connection;
    if (selected.kind !== "external") throw new Error("CODEX_AUTH_SELECTION_INVALID: The applied Codex location is unavailable.");
    projected.CODEX_HOME = knownExternalHome(readAuthSelection(projected), selected.homeId);
  }
  if (!projected.CODEX_HOME && (connection === "bridge-chatgpt" || connection === "bridge-api")) {
    const selected = desired.connection;
    if (selected.kind !== connection) throw new Error("CODEX_AUTH_SELECTION_INVALID: The applied authentication profile is unavailable.");
    projected.CODEX_HOME = authProfileHome(authSelectionRoot(projected), selected.profileId);
  }
  if (connection === "external" || connection === "bridge-chatgpt" || connection === "bridge-api") {
    delete projected.OPENAI_API_KEY;
    delete projected.CODEX_API_KEY;
  }
  if (connection === "disconnected") projected.CODEX_MCP_BRIDGE_AUTH_DISCONNECTED = "1";
  for (const name of Object.keys(projected)) {
    if (name.startsWith("CONTROL_PLANE_") || name.startsWith("CLOUDFLARED_") ||
        name === "TUNNEL_CLIENT" || name.startsWith("TUNNEL_CLIENT_") ||
        name === "CODEX_MCP_BRIDGE_TOKEN" || name === "CODEX_GPT_BRIDGE_TOKEN" ||
        name.startsWith("CODEX_MCP_BRIDGE_OAUTH_") || name.startsWith("CODEX_GPT_BRIDGE_OAUTH_")) {
      delete projected[name];
    }
  }
  return projected;
}

/** A private status marker; raw proxy credentials and paths are never emitted. */
export function codexChildEnvironmentFingerprint(environment) {
  const effective = codexChildEnvironment(undefined, environment);
  return createHash("sha256").update(JSON.stringify(
    ["HOME", "PATH", ...CODEX_CHILD_ENV_KEYS.filter(name => name !== "CODEX_GPT_BRIDGE_CODEX")]
      .map(name => [name, name === "HOME" || name === "PATH" ? environment[name] ?? null : effective[name] ?? null])
  )).digest("hex");
}

const DEFAULT_OPERATOR_CONFIGURATION = Object.freeze({
  defaultBackend: "app-server",
  maximumAccess: "read-only"
});

export function defaultRuntimeEnvFile({ environment = process.env, homeDirectory = homedir() } = {}) {
  const configHome = environment.XDG_CONFIG_HOME || resolve(homeDirectory, ".config");
  return resolve(configHome, RUNTIME_CONFIG_DIRECTORY, RUNTIME_ENV_FILENAME);
}

export function resolveRuntimeEnvFile({
  explicitPath,
  environment = process.env,
  homeDirectory = homedir(),
  repoRoot = process.cwd(),
  fileExists = pathEntryExists
} = {}) {
  const requestedPath = explicitPath || environment.CODEX_MCP_BRIDGE_ENV_FILE;
  if (requestedPath) return resolveFromRepo(requestedPath, repoRoot);

  const operatorFile = defaultRuntimeEnvFile({ environment, homeDirectory });
  if (fileExists(operatorFile)) return operatorFile;

  const repositoryFile = resolve(repoRoot, RUNTIME_ENV_FILENAME);
  return fileExists(repositoryFile) ? repositoryFile : operatorFile;
}

export function loadRuntimeEnvFile(
  filePath,
  {
    required = false,
    allowedKey,
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  if (!pathEntryExists(filePath)) {
    if (required) throw new Error(`Runtime environment file not found: ${filePath}`);
    return false;
  }

  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Runtime environment must be a regular, non-symlink file: ${filePath}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime environment must be owned by the current user: ${filePath}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Runtime environment permissions are too broad; run chmod 600 ${filePath}`);
    }
  }

  const values = parseEnv(readRuntimeEnvText(filePath));
  for (const [key, value] of Object.entries(values)) {
    // Match process.loadEnvFile's no-overwrite behavior while keeping the
    // selected bytes under this module's strict UTF-8 policy. NODE_OPTIONS is
    // intentionally not accepted from dotenv files.
    if (key !== "NODE_OPTIONS" && (!allowedKey || allowedKey(key)) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

export function validateSecureTunnelEnvironment(environment = process.env, filePath) {
  const sourceHint = filePath ? `; configure ${filePath} or export it explicitly` : "";
  const apiKey = environment.CONTROL_PLANE_API_KEY;
  const tunnelId = environment.CONTROL_PLANE_TUNNEL_ID;

  if (!apiKey) {
    throw new Error(`Secure mode needs CONTROL_PLANE_API_KEY${sourceHint}.`);
  }
  if (!/^sk-[^\s]{16,}$/.test(apiKey) || isPlaceholder(apiKey)) {
    throw new Error(`CONTROL_PLANE_API_KEY is malformed or still a placeholder${sourceHint}.`);
  }
  if (!tunnelId) {
    throw new Error(`Secure mode needs CONTROL_PLANE_TUNNEL_ID${sourceHint}.`);
  }
  if (!/^tunnel_[a-z0-9]{32}$/.test(tunnelId) || isPlaceholder(tunnelId)) {
    throw new Error(
      `CONTROL_PLANE_TUNNEL_ID must be tunnel_ followed by 32 lowercase letters or digits${sourceHint}.`
    );
  }

  return { apiKey, tunnelId };
}

export function inspectRuntimeEnvFile(
  filePath,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolvedPath = resolve(filePath);
  if (!pathEntryExists(resolvedPath)) {
    const directory = dirname(resolvedPath);
    try {
      if (pathEntryExists(directory)) {
        assertRuntimeEnvDirectory(directory, { platform, uid });
      }
    } catch (error) {
      const issue = safeRuntimeEnvIssue(error);
      return {
        path: resolvedPath,
        exists: false,
        valid: false,
        hasApiKey: false,
        hasTunnelId: false,
        tunnelId: null,
        operatorConfiguration: DEFAULT_OPERATOR_CONFIGURATION,
        issue,
        issueProblem: runtimeEnvIssueProblem(issue)
      };
    }
    return {
      path: resolvedPath,
      exists: false,
      valid: false,
      hasApiKey: false,
      hasTunnelId: false,
      tunnelId: null,
      operatorConfiguration: DEFAULT_OPERATOR_CONFIGURATION,
      issue: "Runtime environment file is not configured.",
      issueProblem: runtimeEnvIssueProblem("Runtime environment file is not configured.")
    };
  }
  try {
    assertRuntimeEnvDirectory(dirname(resolvedPath), { platform, uid });
    assertPrivateRuntimeEnvFile(resolvedPath, { platform, uid });
    const values = readManagedRuntimeEnvValues(readRuntimeEnvText(resolvedPath));
    validateSecureTunnelEnvironment(values, resolvedPath);
    return {
      path: resolvedPath,
      exists: true,
      valid: true,
      hasApiKey: Boolean(values.CONTROL_PLANE_API_KEY),
      hasTunnelId: Boolean(values.CONTROL_PLANE_TUNNEL_ID),
      tunnelId: values.CONTROL_PLANE_TUNNEL_ID || null,
      operatorConfiguration: runtimeOperatorConfiguration(values),
      issue: null,
      issueProblem: null
    };
  } catch (error) {
    const issue = safeRuntimeEnvIssue(error);
    return {
      path: resolvedPath,
      exists: true,
      valid: false,
      hasApiKey: false,
      hasTunnelId: false,
      tunnelId: null,
      operatorConfiguration: DEFAULT_OPERATOR_CONFIGURATION,
      issue,
      issueProblem: runtimeEnvIssueProblem(issue)
    };
  }
}

export function repairRuntimeEnvPermissions(
  filePath,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolvedPath = resolve(filePath);
  const directory = dirname(resolvedPath);
  if (!pathEntryExists(directory)) {
    throw new Error(`Runtime environment directory not found: ${directory}`);
  }
  const directoryStats = lstatSync(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`Runtime environment directory must be a regular directory: ${directory}`);
  }
  const fileExists = pathEntryExists(resolvedPath);
  const fileStats = fileExists ? lstatSync(resolvedPath) : undefined;
  if (fileStats && (fileStats.isSymbolicLink() || !fileStats.isFile())) {
    throw new Error(`Runtime environment must be a regular, non-symlink file: ${resolvedPath}`);
  }
  if (platform !== "win32") {
    if (
      typeof uid === "number" &&
      (directoryStats.uid !== uid || (fileStats && fileStats.uid !== uid))
    ) {
      throw new Error("Runtime environment file and directory must be owned by the current user.");
    }
    if (
      (directoryStats.mode & 0o022) !== 0 ||
      (fileStats !== undefined && (fileStats.mode & 0o022) !== 0)
    ) {
      throw new Error(
        "Runtime environment permissions cannot be repaired automatically while group or world writable."
      );
    }
    chmodSync(directory, 0o700);
    if (fileExists) chmodSync(resolvedPath, 0o600);
  }
  return inspectRuntimeEnvFile(resolvedPath, { platform, uid });
}

/**
 * Read only explicitly requested values from a verified dotenv file. Normal
 * callers require private permissions. Permission-repair preflight may opt in
 * to an owned, regular, over-readable path, but never a group/world-writable
 * one. The native helper uses this without loading tunnel credentials into its
 * process environment.
 */
export function readRuntimeEnvSubset(
  filePath,
  keys,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined,
    allowBroadReadOnlyPermissions = false
  } = {}
) {
  const resolvedPath = resolve(filePath);
  if (!pathEntryExists(resolvedPath)) return {};
  const verification = { platform, uid, allowBroadReadOnlyPermissions };
  assertRuntimeEnvDirectory(dirname(resolvedPath), verification);
  assertPrivateRuntimeEnvFile(resolvedPath, verification);
  if (!Array.isArray(keys) || keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    throw new Error("Runtime environment subset keys must be valid environment names.");
  }
  return readSelectedRuntimeEnvValues(readRuntimeEnvText(resolvedPath), new Set(keys));
}

/**
 * Prepare and validate a dotenv replacement without changing the file. The
 * returned value is intentionally opaque to callers outside the helper and
 * must never be logged or serialized because it retains the prior and next
 * file contents for rollback.
 */
export function prepareRuntimeEnvUpdate(
  filePath,
  { apiKey, tunnelId, defaultBackend, maximumAccess },
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined
  } = {}
) {
  const resolvedPath = resolve(filePath);
  const directory = dirname(resolvedPath);
  ensurePrivateRuntimeDirectory(directory, { platform, uid });

  const existed = pathEntryExists(resolvedPath);
  if (existed) assertPrivateRuntimeEnvFile(resolvedPath, { platform, uid });
  const original = existed ? readRuntimeEnvText(resolvedPath) : "";
  const previousValues = readManagedRuntimeEnvValues(original);
  const operatorUpdates = runtimeOperatorUpdates({ defaultBackend, maximumAccess });
  const updates = {
    ...(typeof apiKey === "string" && apiKey.trim() ? { CONTROL_PLANE_API_KEY: apiKey.trim() } : {}),
    ...(typeof tunnelId === "string" && tunnelId.trim()
      ? { CONTROL_PLANE_TUNNEL_ID: tunnelId.trim() }
      : {}),
    ...operatorUpdates
  };
  const next = mergeManagedRuntimeEnv(original, updates);
  const nextValues = readManagedRuntimeEnvValues(next);
  validateSecureTunnelEnvironment(nextValues, resolvedPath);

  return Object.freeze({
    path: resolvedPath,
    directory,
    existed,
    original,
    next,
    changed: next !== original,
    tunnelIdChanged:
      previousValues.CONTROL_PLANE_TUNNEL_ID !== nextValues.CONTROL_PLANE_TUNNEL_ID,
    platform,
    uid
  });
}

export function commitRuntimeEnvUpdate(
  prepared,
  { renameFile = renameSync } = {}
) {
  assertPreparedRuntimeEnvUpdate(prepared);
  assertRuntimeEnvUnchanged(prepared, prepared.original, prepared.existed);
  if (!prepared.changed) {
    return inspectRuntimeEnvFile(prepared.path, prepared);
  }
  writeAtomicPrivateRuntimeEnv(prepared.path, prepared.next, {
    ...prepared,
    renameFile,
    validate: true
  });
  return inspectRuntimeEnvFile(prepared.path, prepared);
}

export function rollbackRuntimeEnvUpdate(prepared) {
  assertPreparedRuntimeEnvUpdate(prepared);
  if (!prepared.changed) return inspectRuntimeEnvFile(prepared.path, prepared);
  assertRuntimeEnvUnchanged(prepared, prepared.next, true);
  if (!prepared.existed) {
    unlinkSync(prepared.path);
    syncDirectory(prepared.directory);
    return inspectRuntimeEnvFile(prepared.path, prepared);
  }
  writeAtomicPrivateRuntimeEnv(prepared.path, prepared.original, {
    ...prepared,
    renameFile: renameSync,
    validate: false
  });
  return inspectRuntimeEnvFile(prepared.path, prepared);
}

/**
 * Atomically update only app-owned tunnel values while retaining every other
 * dotenv line byte-for-byte. Empty inputs intentionally preserve existing
 * values so the native app never has to reveal a saved key again.
 */
export function updateRuntimeEnvFile(
  filePath,
  { apiKey, tunnelId, defaultBackend, maximumAccess },
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : undefined,
    renameFile = renameSync
  } = {}
) {
  const prepared = prepareRuntimeEnvUpdate(
    filePath,
    { apiKey, tunnelId, defaultBackend, maximumAccess },
    { platform, uid }
  );
  return commitRuntimeEnvUpdate(prepared, { renameFile });
}

function runtimeOperatorUpdates({ defaultBackend, maximumAccess }) {
  const updates = {};
  if (defaultBackend !== undefined) {
    if (defaultBackend !== "app-server") {
      throw new Error(`Invalid Codex execution backend: ${String(defaultBackend)}`);
    }
    updates.CODEX_MCP_BRIDGE_DEFAULT_BACKEND = defaultBackend;
  }
  if (maximumAccess !== undefined) {
    if (!["read-only", "workspace-write", "full-access"].includes(maximumAccess)) {
      throw new Error(`Invalid maximum access level: ${String(maximumAccess)}`);
    }
    updates.CODEX_MCP_BRIDGE_ALLOW_WRITE = maximumAccess === "read-only" ? "0" : "1";
    updates.CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS = maximumAccess === "full-access" ? "1" : "0";
  }
  return updates;
}

function runtimeOperatorConfiguration(values) {
  const dangerFullAccess = runtimeBoolean(values.CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS);
  const workspaceWrite = dangerFullAccess || runtimeBoolean(values.CODEX_MCP_BRIDGE_ALLOW_WRITE);
  return {
    defaultBackend: "app-server",
    maximumAccess: dangerFullAccess
      ? "full-access"
      : workspaceWrite
        ? "workspace-write"
        : "read-only"
  };
}

function runtimeBoolean(value) {
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function writeAtomicPrivateRuntimeEnv(filePath, contents, options) {
  const temporaryPath = resolve(
    options.directory,
    `.${RUNTIME_ENV_FILENAME}.${randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    assertPrivateRuntimeEnvFile(temporaryPath, options);
    if (options.validate) {
      validateSecureTunnelEnvironment(
        readManagedRuntimeEnvValues(readRuntimeEnvText(temporaryPath)),
        filePath
      );
    }
    options.renameFile(temporaryPath, filePath);
    syncDirectory(options.directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (pathEntryExists(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original error; a same-directory private temp file is safe
      // to remove on the next setup attempt.
    }
    throw error;
  }
}

function assertPreparedRuntimeEnvUpdate(prepared) {
  if (
    !prepared ||
    typeof prepared !== "object" ||
    typeof prepared.path !== "string" ||
    typeof prepared.directory !== "string" ||
    typeof prepared.original !== "string" ||
    typeof prepared.next !== "string" ||
    typeof prepared.existed !== "boolean"
  ) {
    throw new Error("Invalid prepared runtime environment update.");
  }
}

function assertRuntimeEnvUnchanged(prepared, expectedContents, expectedExists) {
  const exists = pathEntryExists(prepared.path);
  if (exists !== expectedExists) {
    throw new Error("RUNTIME_ENV_CHANGED: Runtime environment changed during the operation.");
  }
  if (!exists) return;
  assertPrivateRuntimeEnvFile(prepared.path, prepared);
  if (readRuntimeEnvText(prepared.path) !== expectedContents) {
    throw new Error("RUNTIME_ENV_CHANGED: Runtime environment changed during the operation.");
  }
}

function readRuntimeEnvText(filePath) {
  return decodeUtf8Strict(readFileSync(filePath), `Runtime environment file ${resolve(filePath)}`);
}

function ensurePrivateRuntimeDirectory(directory, { platform, uid }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRuntimeEnvDirectory(directory, { platform, uid });
}

function assertRuntimeEnvDirectory(
  directory,
  { platform, uid, allowBroadReadOnlyPermissions = false }
) {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Runtime environment directory must be a regular directory: ${directory}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime environment directory must be owned by the current user: ${directory}`);
    }
    if (
      (stats.mode & 0o077) !== 0 &&
      !(allowBroadReadOnlyPermissions && (stats.mode & 0o022) === 0)
    ) {
      throw new Error(`Runtime environment directory permissions are too broad: ${directory}`);
    }
  }
}

function assertPrivateRuntimeEnvFile(
  filePath,
  { platform, uid, allowBroadReadOnlyPermissions = false }
) {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Runtime environment must be a regular, non-symlink file: ${filePath}`);
  }
  if (platform !== "win32") {
    if (typeof uid === "number" && stats.uid !== uid) {
      throw new Error(`Runtime environment must be owned by the current user: ${filePath}`);
    }
    if (
      (stats.mode & 0o077) !== 0 &&
      !(allowBroadReadOnlyPermissions && (stats.mode & 0o022) === 0)
    ) {
      throw new Error(`Runtime environment permissions are too broad; run chmod 600 ${filePath}`);
    }
  }
}

function mergeManagedRuntimeEnv(source, updates) {
  if (source.includes("\0")) throw new Error("Runtime environment contains an invalid NUL byte.");
  const seen = new Set();
  const parts = source.length === 0 ? [] : source.split(/(\r\n|\n)/);
  let merged = "";
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] || "";
    const separator = parts[index + 1] || "";
    const assignment = dotenvAssignment(line);
    const key = assignment?.key;
    let nextLine = line;
    if (key && RUNTIME_ENV_MANAGED_KEYS.includes(key)) {
      if (seen.has(key)) {
        throw new Error(`Runtime environment contains duplicate ${key} entries.`);
      }
      seen.add(key);
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        nextLine = `${assignment.prefix}${updates[key]}${assignment.commentSuffix}`;
      }
    }
    merged += `${nextLine}${separator}`;
  }
  const additions = [];
  for (const key of RUNTIME_ENV_MANAGED_KEYS) {
    if (!seen.has(key) && Object.prototype.hasOwnProperty.call(updates, key)) {
      additions.push(`${key}=${updates[key]}`);
    }
  }
  if (additions.length === 0) return merged;

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const retainedTrailingNewline = source.length === 0 || source.endsWith("\n");
  if (merged && !merged.endsWith("\n")) merged += newline;
  merged += additions.join(newline);
  if (retainedTrailingNewline) merged += newline;
  return merged;
}

function readManagedRuntimeEnvValues(source) {
  if (source.includes("\0")) throw new Error("Runtime environment contains an invalid NUL byte.");
  const values = {};
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const key = dotenvAssignmentKey(line);
    if (!key || !RUNTIME_ENV_MANAGED_KEYS.includes(key)) continue;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Runtime environment contains duplicate ${key} entries.`);
    }
    const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
    values[key] = parseDotenvValue(assignment?.[1] || "");
  }
  return values;
}

function readSelectedRuntimeEnvValues(source, selectedKeys) {
  if (source.includes("\0")) throw new Error("Runtime environment contains an invalid NUL byte.");
  const values = {};
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const key = dotenvAssignmentKey(line);
    if (!key || !selectedKeys.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Runtime environment contains duplicate ${key} entries.`);
    }
    const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
    values[key] = parseDotenvValue(assignment?.[1] || "");
  }
  return values;
}

function dotenvAssignmentKey(line) {
  return dotenvAssignment(line)?.key;
}

function parseDotenvValue(raw) {
  return parseEnv(`RUNTIME_VALUE=${raw}\n`).RUNTIME_VALUE || "";
}

function dotenvAssignment(line) {
  const match = line.match(/^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$/);
  if (!match) return undefined;
  const raw = match[3];
  const commentIndex = dotenvCommentIndex(raw);
  let suffixStart = commentIndex;
  while (suffixStart > 0 && /\s/.test(raw[suffixStart - 1])) suffixStart -= 1;
  return {
    key: match[2],
    prefix: match[1],
    commentSuffix: commentIndex < raw.length ? raw.slice(suffixStart) : ""
  };
}

function dotenvCommentIndex(raw) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (quote === '"' && character === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (character === quote && !escaped) quote = "";
      escaped = false;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return index;
    }
  }
  return raw.length;
}

function safeRuntimeEnvIssue(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000) || "Runtime environment is invalid.";
}

function runtimeEnvIssueProblem(message) {
  let code = "runtime-env-invalid";
  if (message.includes("not configured")) {
    code = "runtime-env-not-configured";
  } else if (message.includes("permissions are too broad")) {
    code = "runtime-env-permissions-too-broad";
  } else if (message.includes("regular, non-symlink") || message.includes("regular directory")) {
    code = "runtime-env-not-regular";
  } else if (message.includes("owned by the current user")) {
    code = "runtime-env-owner-mismatch";
  } else if (message.includes("CONTROL_PLANE_API_KEY")) {
    code = "runtime-api-key-invalid";
  } else if (message.includes("CONTROL_PLANE_TUNNEL_ID")) {
    code = "tunnel-id-invalid";
  } else if (message.includes("RUNTIME_ENV_PROJECT_CONFLICT")) {
    code = "runtime-env-project-conflict";
  } else if (message.includes("invalid NUL byte") || message.includes("duplicate")) {
    code = "runtime-env-invalid-content";
  }
  return { code, arguments: {} };
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support fsync on directories. The file itself
    // was already fsynced before the atomic rename.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function pathEntryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveFromRepo(filePath, repoRoot) {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
}

function isPlaceholder(value) {
  return /^(?:<.*>|replace[-_]|your[-_]|sk-\.\.\.|tunnel_\.\.\.)/i.test(value);
}
