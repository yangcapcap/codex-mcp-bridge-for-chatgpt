#!/usr/bin/env node
// Complete JS/TS suite, or explicit fixture suites. Operator runs full sockets on host.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
const root = fileURLToPath(new URL("..", import.meta.url));
const raw = process.argv.slice(2);
const supportedFlags = new Set(["--host-short-root", "--host-exclusive"]);
const unknownFlags = raw.filter(value => value.startsWith("--") && !supportedFlags.has(value));
if (unknownFlags.length) throw new Error(`Unknown validation runner flag: ${unknownFlags.join(", ")}`);
const hostExclusive = raw.includes("--host-exclusive");
// Host-native fixtures use Unix sockets and launchd-shaped paths. Keep their
// fixture root short by construction; callers may still opt into the same
// behavior explicitly for non-exclusive diagnostics.
const shortRoot = raw.includes("--host-short-root") || hostExclusive;
const requested = raw.filter(value => !supportedFlags.has(value));
if (hostExclusive && requested.length === 0) throw new Error("Host-exclusive validation requires an explicit suite list; it cannot make the full suite single-worker.");
// Run each host-native suite in its own child process and fixture root. A
// single Vitest process lets stateful coordinators, watchers, sockets, and
// state databases outlive their suite even when their local teardown awaits.
if (hostExclusive && requested.length > 1) {
  let status = 0;
  for (const suite of requested) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--host-exclusive", suite],
      { cwd: root, env: process.env, stdio: "inherit" });
    if (result.error) throw result.error;
    status = result.status ?? 1;
    if (status !== 0) break;
  }
  process.exitCode = status;
  process.exit();
}
const runtimeDist = process.env.CODEX_BRIDGE_TEST_RUNTIME_DIST;
if (runtimeDist && (path.resolve(runtimeDist)!==runtimeDist || !runtimeDist.startsWith(path.join(root, "output")+path.sep) ||
    realpathSync(runtimeDist)!==runtimeDist || !existsSync(path.join(runtimeDist,"build-info.json")))) throw new Error("Runtime tests require an exact isolated candidate dist under checkout/output");
if (requested.some(name => !/^test\/[a-zA-Z0-9_.-]+\.test\.ts$/.test(name) || !existsSync(path.join(root, name)))) throw new Error("Pass only existing test/*.test.ts suites, or no arguments for the full suite.");
const validationParent = path.join(root, "output");
mkdirSync(validationParent, { recursive: true, mode: 0o700 });
// Explicit host-only opt-in. Default remains inside the writable worktree.
// A short canonical owned directory avoids macOS's 104-byte sun_path limit.
const temporary = realpathSync(mkdtempSync(shortRoot ? path.join(realpathSync("/tmp"), "cgv-") : path.join(validationParent, "v-")));
const shortRootToken = shortRoot ? randomUUID() : undefined;
if (shortRootToken) writeFileSync(path.join(temporary, ".isolation-owner.json"), JSON.stringify({
  root: temporary, checkout: realpathSync(root), token: shortRootToken, uid: process.getuid?.()
}), { mode: 0o600, flag: "wx" });
const dirs = Object.fromEntries(["home", "codex", "config", "cache", "data", "state", "runtime", "tmp", "bin", "npm"].map(name => {
  const dir = path.join(temporary, name === "tmp" ? "t" : name); mkdirSync(dir, { mode: 0o700 }); return [name, dir];
}));
const npmCandidate = path.join(path.dirname(process.execPath), "npm");
const npmCli = existsSync(npmCandidate) ? realpathSync(npmCandidate) : path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
if (!existsSync(npmCli)) throw new Error("Installed npm CLI was not found beside Node; provision local validation tools first.");
symlinkSync(process.execPath, path.join(dirs.bin, "node"));
// Only offline packaging is needed by the suite. No install/update/global tool writes.
writeFileSync(path.join(dirs.bin, "npm"), `#!${process.execPath}\nif (process.argv[2] !== 'pack') throw new Error('Isolated validation permits npm pack only');\nawait import(${JSON.stringify(npmCli)});\n`, { mode: 0o700 });
const env = {
  PATH: `${dirs.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dirs.home,
  XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_DATA_HOME: dirs.data,
  XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.runtime, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
  npm_config_cache: dirs.npm, npm_config_offline: "true", npm_config_ignore_scripts: "true",
  npm_config_userconfig: path.join(dirs.npm, "empty-npmrc"), npm_config_globalconfig: path.join(dirs.npm, "empty-global-npmrc"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(dirs.home, "empty-gitconfig"),
  LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", SHELL: "/bin/sh",
  GATEWAY_VALIDATION_ROOT: temporary,
  ...(runtimeDist ? { CODEX_BRIDGE_TEST_RUNTIME_DIST: runtimeDist } : {}),
  ...(shortRootToken ? { GATEWAY_VALIDATION_SHORT_ROOT_TOKEN: shortRootToken } : {}),
  NODE_OPTIONS: `--import=${path.join(root, "scripts/test-isolation-guard.mjs")}`
};
// Some managed macOS sandboxes allow versioned Cellar libraries but deny the
// mutable /opt/homebrew/opt aliases. Preserve only canonical installed library
// directories, never arbitrary project/user loader paths. OS grants stay intact.
if (process.platform === "darwin" && process.env.DYLD_LIBRARY_PATH) {
  const libraries = process.env.DYLD_LIBRARY_PATH.split(":");
  if (libraries.some(dir => !/^\/opt\/homebrew\/Cellar\/[a-zA-Z0-9@_-]+\/[0-9][a-zA-Z0-9_.-]*\/lib$/.test(dir) || realpathSync(dir) !== dir)) {
    throw new Error("Validation loader paths must be canonical versioned Homebrew libraries.");
  }
  env.DYLD_LIBRARY_PATH = libraries.join(":");
}
// LibreSSL requires a req distinguished_name section even with explicit -subj.
// Keep this deterministic and private; never fall back to host OpenSSL config.
env.OPENSSL_CONF = path.join(dirs.config, "fixture-openssl.cnf");
writeFileSync(env.OPENSSL_CONF, "[req]\ndistinguished_name=fixture_dn\n[fixture_dn]\nCN=Isolated fixture\n", { mode: 0o600 });
for (const file of [env.npm_config_userconfig, env.npm_config_globalconfig, env.GIT_CONFIG_GLOBAL]) writeFileSync(file, "", { mode: 0o600 });
// Vitest positional file filters are fuzzy (server.test.ts also selects helper
// and companion servers). Exact requested suites need explicit include paths;
// this changes selection only, not isolation, assertions or the full-suite run.
const selectedConfig = path.join(temporary, "selected-vitest.config.mjs");
writeFileSync(selectedConfig,
  `export default ${JSON.stringify({ root, cacheDir: path.join(dirs.cache, "vite"), test: { include: requested.length ? requested : ["test/**/*.test.ts"] } })};\n`, { mode: 0o600 });
try {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run",
    hostExclusive ? "--maxWorkers=1" : "--maxWorkers=2",
    "--configLoader", "native", "--config", selectedConfig], { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
