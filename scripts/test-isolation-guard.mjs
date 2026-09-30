// Test-process tripwires, not a production sandbox. Only harmless loopback and
// temporary Unix sockets are allowed. Real runtime discovery is fixture-only.
import net from "node:net";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const fixtureRoot = process.env.GATEWAY_VALIDATION_ROOT;
const checkout = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const rootInfo = fixtureRoot ? fs.lstatSync(fixtureRoot) : undefined;
const canonicalOwnedRoot = rootInfo?.isDirectory() && !rootInfo.isSymbolicLink() &&
  rootInfo.uid === process.getuid?.() && (rootInfo.mode & 0o077) === 0 && fs.realpathSync(fixtureRoot) === fixtureRoot;
const defaultRoot = fixtureRoot && path.dirname(fixtureRoot) === path.join(checkout, "output") && /^v-[A-Za-z0-9]{6}$/.test(path.basename(fixtureRoot));
let hostRoot = false;
if (canonicalOwnedRoot && process.env.GATEWAY_VALIDATION_SHORT_ROOT_TOKEN &&
    path.dirname(fixtureRoot) === fs.realpathSync("/tmp") && /^cgv-[A-Za-z0-9]+$/.test(path.basename(fixtureRoot))) {
  const marker = path.join(fixtureRoot, ".isolation-owner.json"), info = fs.lstatSync(marker);
  if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && info.size < 4096) {
    const owner = JSON.parse(fs.readFileSync(marker, "utf8"));
    hostRoot = owner.root === fixtureRoot && owner.checkout === checkout && owner.uid === process.getuid?.() &&
      owner.token === process.env.GATEWAY_VALIDATION_SHORT_ROOT_TOKEN;
  }
}
if (!canonicalOwnedRoot || !defaultRoot && !hostRoot) throw new Error("Isolation guard requires its owned disposable validation root.");
const local = host => [undefined, "localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
const inside = candidate => typeof candidate === "string" && path.resolve(candidate).startsWith(`${fixtureRoot}/`);
const portsFile = path.join(fixtureRoot, "fixture-ports.jsonl");
const knownPort = port => {
  try { return fs.readFileSync(portsFile, "utf8").trim().split("\n").some(value => Number(value) === Number(port)); }
  catch { return false; }
};
const normalize = net._normalizeArgs;
// Node createConnection forwards an already-normalized tuple into connect.
// Preserve its options instead of accidentally nesting the tuple again.
const optionsFor = args => args.length === 1 && Array.isArray(args[0]) && args[0].length === 2 &&
  args[0][0] && typeof args[0][0] === "object" ? args[0][0] : normalize(args)[0];
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const options = optionsFor(args);
  if (options.path ? !inside(options.path) : Number(options.port) !== 0 && !knownPort(options.port)) throw new Error("ISOLATED_TEST_NONFIXTURE_LISTENER_BLOCKED");
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") fs.appendFileSync(portsFile, String(address.port) + "\n", { mode: 0o600 });
  });
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = optionsFor(args);
  if (options.path ? !inside(options.path) : !local(options.host) || !knownPort(options.port)) throw new Error("ISOLATED_TEST_EXTERNAL_SOCKET_BLOCKED");
  return connect.apply(this, args);
};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) throw new Error("ISOLATED_TEST_EXTERNAL_FETCH_BLOCKED");
  return fetchOriginal(input, options);
};
// Default installed-app discovery must not even probe global applications.
const externalApp = file => typeof file === "string" && /\/Applications\/(Codex|ChatGPT)\.app\//.test(file) && !inside(file);
const access = fs.access, accessSync = fs.accessSync, accessAsync = fsPromises.access;
fs.access = (file, ...args) => externalApp(file) ? args.at(-1)(Object.assign(new Error("Fixture-only application discovery"), { code: "ENOENT" })) : access(file, ...args);
fs.accessSync = (file, ...args) => { if (externalApp(file)) throw Object.assign(new Error("Fixture-only application discovery"), { code: "ENOENT" }); return accessSync(file, ...args); };
fsPromises.access = async (file, ...args) => { if (externalApp(file)) throw Object.assign(new Error("Fixture-only application discovery"), { code: "ENOENT" }); return accessAsync(file, ...args); };
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  const check = command => {
    if (typeof command === "string" && /(?:^|\/)(?:codex|codex\.js)$/.test(command) && !inside(command)) throw new Error("ISOLATED_TEST_REAL_RUNTIME_BLOCKED");
  };
  childProcess[name] = (command, ...args) => {
    check(command);
    return original(command, ...args);
  };
  if (original[promisify.custom]) childProcess[name][promisify.custom] = (command, ...args) => {
    check(command); return original[promisify.custom](command, ...args);
  };
}
syncBuiltinESMExports();
