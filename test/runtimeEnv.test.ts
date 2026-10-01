import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexChildEnvironment,
  codexChildEnvironmentFingerprint,
  codexProcessEnvironment,
  commitRuntimeEnvUpdate,
  defaultRuntimeEnvFile,
  inspectRuntimeEnvFile,
  loadRuntimeEnvFile,
  prepareRuntimeEnvUpdate,
  readRuntimeEnvSubset,
  repairRuntimeEnvPermissions,
  resolveRuntimeEnvFile,
  rollbackRuntimeEnvUpdate,
  updateRuntimeEnvFile,
  validateSecureTunnelEnvironment
} from "../scripts/runtime-env.mjs";

const originalApiKey = process.env.CONTROL_PLANE_API_KEY;
const originalTunnelId = process.env.CONTROL_PLANE_TUNNEL_ID;
const originalAllowedTest = process.env.APP_ALLOWED_TEST;
const originalBlockedTest = process.env.APP_BLOCKED_TEST;

afterEach(() => {
  restoreEnvironment("CONTROL_PLANE_API_KEY", originalApiKey);
  restoreEnvironment("CONTROL_PLANE_TUNNEL_ID", originalTunnelId);
  restoreEnvironment("APP_ALLOWED_TEST", originalAllowedTest);
  restoreEnvironment("APP_BLOCKED_TEST", originalBlockedTest);
});

describe("runtime environment", () => {
  it("removes tunnel-only credentials before a selected Codex process starts", () => {
    const projected = codexProcessEnvironment({
      CODEX_HOME: "/selected/home",
      HTTPS_PROXY: "http://proxy.fixture.invalid",
      OPENAI_API_KEY: "explicit-codex-auth",
      CONTROL_PLANE_API_KEY: "tunnel-only",
      CONTROL_PLANE_TUNNEL_ID: "tunnel-only",
      CLOUDFLARED_TUNNEL_TOKEN: "tunnel-only",
      TUNNEL_CLIENT_CONFIG: "/private/tunnel-config",
      CODEX_MCP_BRIDGE_TOKEN: "bridge-only",
      CODEX_MCP_BRIDGE_OAUTH_ISSUER: "https://id.example",
      CODEX_GPT_BRIDGE_OAUTH_OPERATOR_SUBJECT: "private-operator"
    });
    expect(projected).toEqual({
      CODEX_HOME: "/selected/home",
      CODEX_MCP_BRIDGE_AUTH_SOURCE: "shared",
      CODEX_MCP_BRIDGE_AUTH_GENERATION: "0",
      HTTPS_PROXY: "http://proxy.fixture.invalid",
      OPENAI_API_KEY: "explicit-codex-auth"
    });
  });
  it("projects the same Codex child settings without tunnel or API credentials", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    writeFileSync(file, [
      "CODEX_MCP_BRIDGE_RUNTIME_HOME=/private/runtime",
      "CODEX_MCP_BRIDGE_CODEX=/file/current",
      "CODEX_GPT_BRIDGE_CODEX=/file/legacy",
      "CODEX_HOME=/private/codex",
      "HTTPS_PROXY=http://file-proxy.invalid",
      "SSL_CERT_FILE=/private/cert.pem",
      "CONTROL_PLANE_API_KEY=sk-file-1234567890123456",
      "CODEX_API_KEY=should-not-pass",
      "OPENAI_API_KEY=should-not-pass",
      ""
    ].join("\n"), { mode: 0o600 });

    const inherited = {
      HOME: "/home/fixture", PATH: "/bin", CODEX_GPT_BRIDGE_CODEX: "/process/legacy",
      HTTP_PROXY: "http://process-proxy.invalid", CONTROL_PLANE_TUNNEL_ID: "tunnel_secret"
    };
    const selected = codexChildEnvironment(file, inherited);
    expect(selected).toMatchObject({
      CODEX_MCP_BRIDGE_RUNTIME_HOME: "/private/runtime",
      CODEX_MCP_BRIDGE_CODEX: "/process/legacy",
      CODEX_HOME: "/private/codex",
      HTTP_PROXY: "http://process-proxy.invalid",
      HTTPS_PROXY: "http://file-proxy.invalid",
      SSL_CERT_FILE: "/private/cert.pem"
    });
    expect(selected).not.toHaveProperty("CODEX_GPT_BRIDGE_CODEX");
    expect(JSON.stringify(selected)).not.toMatch(/CONTROL_PLANE|OPENAI_API_KEY|CODEX_API_KEY|tunnel_secret/);
    expect(codexChildEnvironmentFingerprint({ ...inherited, ...selected })).toMatch(/^[a-f0-9]{64}$/);
    expect(codexChildEnvironmentFingerprint({ ...inherited, ...selected, HTTPS_PROXY: "http://changed.invalid" }))
      .not.toBe(codexChildEnvironmentFingerprint({ ...inherited, ...selected }));
  });
  it("defaults outside the repository and falls back to a repository .env", () => {
    const root = temporaryDirectory();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const operatorFile = defaultRuntimeEnvFile({ environment: {}, homeDirectory: home });
    expect(operatorFile).toBe(path.join(home, ".config", "codex-mcp-bridge", ".env"));
    expect(resolveRuntimeEnvFile({ environment: {}, homeDirectory: home, repoRoot: repo })).toBe(operatorFile);

    writeFileSync(path.join(repo, ".env"), "CONTROL_PLANE_TUNNEL_ID=tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr\n", { mode: 0o600 });
    expect(resolveRuntimeEnvFile({ environment: {}, homeDirectory: home, repoRoot: repo })).toBe(
      path.join(repo, ".env")
    );
  });

  it("prefers an explicit path and CODEX_MCP_BRIDGE_ENV_FILE", () => {
    const root = temporaryDirectory();
    expect(resolveRuntimeEnvFile({
      explicitPath: "explicit.env",
      environment: { CODEX_MCP_BRIDGE_ENV_FILE: "ignored.env" },
      repoRoot: root
    })).toBe(path.join(root, "explicit.env"));
    expect(resolveRuntimeEnvFile({
      environment: { CODEX_MCP_BRIDGE_ENV_FILE: "selected.env" },
      repoRoot: root
    })).toBe(path.join(root, "selected.env"));
  });

  it("loads a private regular dotenv file without overriding exported values", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-file-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_ffffffffffffffffffffffffffffffff\n",
      { mode: 0o600 }
    );
    process.env.CONTROL_PLANE_API_KEY = "sk-exported-1234567890123456";
    delete process.env.CONTROL_PLANE_TUNNEL_ID;

    expect(loadRuntimeEnvFile(file)).toBe(true);
    expect(process.env.CONTROL_PLANE_API_KEY).toBe("sk-exported-1234567890123456");
    expect(process.env.CONTROL_PLANE_TUNNEL_ID).toBe("tunnel_ffffffffffffffffffffffffffffffff");
  });

  it("rejects malformed UTF-8 before any dotenv value can mutate the environment", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    writeFileSync(file, Buffer.concat([
      Buffer.from("APP_ALLOWED_TEST=must-not-load\\n", "utf8"),
      Buffer.from([0xc3, 0x28])
    ]), { mode: 0o600 });
    delete process.env.APP_ALLOWED_TEST;

    expect(() => loadRuntimeEnvFile(file, {
      allowedKey: (key: string) => key === "APP_ALLOWED_TEST"
    })).toThrow(/valid UTF-8/i);
    expect(process.env.APP_ALLOWED_TEST).toBeUndefined();
  });

  it("can load only an app-managed allowlist while preserving the file", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    const contents = [
      "APP_ALLOWED_TEST='selected value'",
      "APP_BLOCKED_TEST=must-not-load",
      ""
    ].join("\n");
    writeFileSync(file, contents, { mode: 0o600 });
    delete process.env.APP_ALLOWED_TEST;
    delete process.env.APP_BLOCKED_TEST;

    expect(loadRuntimeEnvFile(file, {
      allowedKey: (key: string) => key === "APP_ALLOWED_TEST"
    })).toBe(true);
    expect(process.env.APP_ALLOWED_TEST).toBe("selected value");
    expect(process.env.APP_BLOCKED_TEST).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("rejects broad permissions and symlinks", () => {
    const root = temporaryDirectory();
    const broad = path.join(root, "broad.env");
    const target = path.join(root, "target.env");
    const link = path.join(root, "link.env");
    writeFileSync(broad, "TOKEN=value\n", { mode: 0o600 });
    chmodSync(broad, 0o644);
    writeFileSync(target, "TOKEN=value\n", { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => loadRuntimeEnvFile(broad)).toThrow("permissions are too broad");
    expect(() => loadRuntimeEnvFile(link)).toThrow("regular, non-symlink file");
  });

  it("repairs only an owned regular dotenv and its direct directory permissions", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    const contents = [
      "# retained comment",
      "CONTROL_PLANE_API_KEY=sk-runtime-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
      "UNRELATED_SETTING=retained",
      ""
    ].join("\n");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, contents, { mode: 0o600 });
    chmodSync(directory, 0o755);
    expect(inspectRuntimeEnvFile(file)).toMatchObject({
      valid: false,
      issue: expect.stringContaining("directory permissions are too broad"),
      issueProblem: { code: "runtime-env-permissions-too-broad", arguments: {} }
    });
    chmodSync(file, 0o644);

    expect(readRuntimeEnvSubset(
      file,
      ["UNRELATED_SETTING"],
      { allowBroadReadOnlyPermissions: true }
    )).toEqual({ UNRELATED_SETTING: "retained" });
    expect(repairRuntimeEnvPermissions(file)).toMatchObject({ valid: true });
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("repairs an owned over-readable configuration directory before first dotenv creation", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "existing-config");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o755 });

    expect(inspectRuntimeEnvFile(file)).toMatchObject({
      exists: false,
      valid: false,
      issue: expect.stringContaining("directory permissions are too broad"),
      issueProblem: { code: "runtime-env-permissions-too-broad", arguments: {} }
    });
    expect(repairRuntimeEnvPermissions(file)).toMatchObject({
      exists: false,
      valid: false,
      issue: expect.stringContaining("not configured"),
      issueProblem: { code: "runtime-env-not-configured", arguments: {} }
    });
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);

    expect(updateRuntimeEnvFile(file, {
      apiKey: "sk-first-run-1234567890123456",
      tunnelId: "tunnel_ffffffffffffffffffffffffffffffff"
    })).toMatchObject({ valid: true });
  });

  it("does not auto-repair group-writable runtime configuration", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "shared");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, [
      "CONTROL_PLANE_API_KEY=sk-runtime-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
      ""
    ].join("\n"), { mode: 0o600 });
    chmodSync(directory, 0o770);
    chmodSync(file, 0o660);

    expect(() => readRuntimeEnvSubset(
      file,
      ["CONTROL_PLANE_TUNNEL_ID"],
      { allowBroadReadOnlyPermissions: true }
    )).toThrow("permissions are too broad");
    expect(() => repairRuntimeEnvPermissions(file)).toThrow("group or world writable");
    expect(lstatSync(directory).mode & 0o777).toBe(0o770);
    expect(lstatSync(file).mode & 0o777).toBe(0o660);
  });

  it("validates secure tunnel values without returning them in errors", () => {
    expect(validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "sk-runtime-1234567890123456",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
    }, "/private/.env")).toEqual({
      apiKey: "sk-runtime-1234567890123456",
      tunnelId: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
    });

    expect(() => validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "<runtime-key>",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"
    }, "/private/.env")).toThrow("malformed or still a placeholder");
    expect(() => validateSecureTunnelEnvironment({
      CONTROL_PLANE_API_KEY: "sk-runtime-1234567890123456",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_too-short"
    }, "/private/.env")).toThrow("32 lowercase letters or digits");
  });

  it("atomically creates a private dotenv and reports only redacted presence", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "private", ".env");
    const status = updateRuntimeEnvFile(file, {
      apiKey: "sk-native-1234567890123456",
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn"
    });

    expect(lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(status).toEqual({
      path: file,
      exists: true,
      valid: true,
      hasApiKey: true,
      hasTunnelId: true,
      tunnelId: "tunnel_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn",
      operatorConfiguration: {
        defaultBackend: "app-server",
        maximumAccess: "read-only"
      },
      issue: null,
      issueProblem: null
    });
    expect(JSON.stringify(status)).not.toContain("sk-native");
  });

  it("atomically stores backend and maximum access without exposing credentials", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "private", ".env");
    updateRuntimeEnvFile(file, {
      apiKey: "sk-native-operator-1234567890123456",
      tunnelId: "tunnel_oooooooooooooooooooooooooooooooo",
      defaultBackend: "app-server",
      maximumAccess: "full-access"
    });

    expect(inspectRuntimeEnvFile(file)).toMatchObject({
      valid: true,
      operatorConfiguration: {
        defaultBackend: "app-server",
        maximumAccess: "full-access"
      }
    });
    expect(readFileSync(file, "utf8")).toContain("CODEX_MCP_BRIDGE_DEFAULT_BACKEND=app-server");
    expect(readFileSync(file, "utf8")).toContain("CODEX_MCP_BRIDGE_ALLOW_WRITE=1");
    expect(readFileSync(file, "utf8")).toContain("CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS=1");

    updateRuntimeEnvFile(file, { maximumAccess: "workspace-write" });
    expect(inspectRuntimeEnvFile(file).operatorConfiguration).toEqual({
      defaultBackend: "app-server",
      maximumAccess: "workspace-write"
    });
    expect(readFileSync(file, "utf8")).toContain("CODEX_MCP_BRIDGE_ALLOW_DANGER_FULL_ACCESS=0");
  });

  it("preserves comments, unknown values, and a saved key when its input is blank", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(
      file,
      [
        "# operator note",
        "UNKNOWN_SETTING=keep-me",
        "CONTROL_PLANE_API_KEY=sk-existing-1234567890123456",
        "CONTROL_PLANE_TUNNEL_ID=tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    updateRuntimeEnvFile(file, {
      apiKey: "",
      tunnelId: "tunnel_pppppppppppppppppppppppppppppppp"
    });

    expect(readFileSync(file, "utf8")).toBe([
      "# operator note",
      "UNKNOWN_SETTING=keep-me",
      "CONTROL_PLANE_API_KEY=sk-existing-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_pppppppppppppppppppppppppppppppp",
      ""
    ].join("\n"));
  });

  it("accepts quoted values with inline comments and preserves those comments on replacement", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, [
      "export CONTROL_PLANE_API_KEY = \"sk-existing-1234567890123456\" # runtime key note",
      "CONTROL_PLANE_TUNNEL_ID = 'tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' # tunnel note",
      ""
    ].join("\n"), { mode: 0o600 });

    expect(inspectRuntimeEnvFile(file)).toMatchObject({ valid: true });
    updateRuntimeEnvFile(file, {
      apiKey: "",
      tunnelId: "tunnel_pppppppppppppppppppppppppppppppp"
    });

    expect(readFileSync(file, "utf8")).toBe([
      "export CONTROL_PLANE_API_KEY = \"sk-existing-1234567890123456\" # runtime key note",
      "CONTROL_PLANE_TUNNEL_ID = tunnel_pppppppppppppppppppppppppppppppp # tunnel note",
      ""
    ].join("\n"));
  });

  it("preserves CRLF separators and the absence of a final newline", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    const original = [
      "# windows-style operator note",
      "UNKNOWN_SETTING=keep-me",
      "CONTROL_PLANE_API_KEY=sk-existing-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    ].join("\r\n");
    writeFileSync(file, original, { mode: 0o600 });

    updateRuntimeEnvFile(file, {
      apiKey: "sk-replaced-1234567890123456",
      tunnelId: ""
    });

    expect(readFileSync(file, "utf8")).toBe([
      "# windows-style operator note",
      "UNKNOWN_SETTING=keep-me",
      "CONTROL_PLANE_API_KEY=sk-replaced-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    ].join("\r\n"));
  });

  it("keeps the original dotenv when the atomic replacement fails", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    const original = [
      "CONTROL_PLANE_API_KEY=sk-original-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
      ""
    ].join("\n");
    writeFileSync(file, original, { mode: 0o600 });

    expect(() => updateRuntimeEnvFile(
      file,
      { apiKey: "sk-replacement-1234567890123456", tunnelId: "" },
      { renameFile: () => { throw new Error("simulated rename failure"); } }
    )).toThrow("simulated rename failure");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(inspectRuntimeEnvFile(file).valid).toBe(true);
  });

  it("stages without changing disk and can roll back a committed replacement", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    const original = [
      "CODEX_HOME=/private/codex-home",
      "CONTROL_PLANE_API_KEY=sk-original-1234567890123456",
      "CONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo",
      ""
    ].join("\n");
    writeFileSync(file, original, { mode: 0o600 });

    const prepared = prepareRuntimeEnvUpdate(file, {
      apiKey: "sk-next-12345678901234567890",
      tunnelId: "tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    });
    expect(prepared.changed).toBe(true);
    expect(prepared.tunnelIdChanged).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);

    commitRuntimeEnvUpdate(prepared);
    expect(readFileSync(file, "utf8")).toContain("tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    rollbackRuntimeEnvUpdate(prepared);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("rejects a staged commit or rollback when another writer changed the file", () => {
    const root = temporaryDirectory();
    const directory = path.join(root, "private");
    const file = path.join(directory, ".env");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-original-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_oooooooooooooooooooooooooooooooo\n",
      { mode: 0o600 }
    );
    const prepared = prepareRuntimeEnvUpdate(file, { tunnelId: "tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-external-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n",
      { mode: 0o600 }
    );
    expect(() => commitRuntimeEnvUpdate(prepared)).toThrow("RUNTIME_ENV_CHANGED");

    const committed = prepareRuntimeEnvUpdate(file, { tunnelId: "tunnel_cccccccccccccccccccccccccccccccc" });
    commitRuntimeEnvUpdate(committed);
    writeFileSync(
      file,
      "CONTROL_PLANE_API_KEY=sk-third-party-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_tttttttttttttttttttttttttttttttt\n",
      { mode: 0o600 }
    );
    expect(() => rollbackRuntimeEnvUpdate(committed)).toThrow("RUNTIME_ENV_CHANGED");
  });

  it("reads only requested helper settings from the private dotenv", () => {
    const root = temporaryDirectory();
    const file = path.join(root, ".env");
    writeFileSync(file, [
      "CONTROL_PLANE_API_KEY=sk-secret-1234567890123456",
      "CODEX_HOME='/private/codex home'",
      "CODEX_MCP_BRIDGE_CODEX=/opt/custom/codex",
      ""
    ].join("\n"), { mode: 0o600 });

    expect(readRuntimeEnvSubset(file, ["CODEX_HOME", "CODEX_MCP_BRIDGE_CODEX"]))
      .toEqual({
        CODEX_HOME: "/private/codex home",
        CODEX_MCP_BRIDGE_CODEX: "/opt/custom/codex"
      });
  });

  it("rejects a symlinked dotenv and an overly broad config directory", () => {
    const root = temporaryDirectory();
    const privateDirectory = path.join(root, "private");
    const target = path.join(privateDirectory, "target.env");
    const link = path.join(privateDirectory, ".env");
    mkdirSync(privateDirectory, { mode: 0o700 });
    writeFileSync(
      target,
      "CONTROL_PLANE_API_KEY=sk-target-1234567890123456\nCONTROL_PLANE_TUNNEL_ID=tunnel_gggggggggggggggggggggggggggggggg\n",
      { mode: 0o600 }
    );
    symlinkSync(target, link);
    expect(() => updateRuntimeEnvFile(link, { apiKey: "", tunnelId: "" }))
      .toThrow("regular, non-symlink file");

    const dangling = path.join(privateDirectory, "dangling.env");
    symlinkSync(path.join(privateDirectory, "missing-target.env"), dangling);
    expect(inspectRuntimeEnvFile(dangling)).toMatchObject({
      exists: true,
      valid: false,
      issue: expect.stringContaining("regular, non-symlink file"),
      issueProblem: { code: "runtime-env-not-regular", arguments: {} }
    });
    expect(() => loadRuntimeEnvFile(dangling)).toThrow("regular, non-symlink file");
    expect(() => repairRuntimeEnvPermissions(dangling)).toThrow("regular, non-symlink file");
    expect(() => updateRuntimeEnvFile(dangling, {
      apiKey: "sk-new-1234567890123456",
      tunnelId: "tunnel_dddddddddddddddddddddddddddddddd"
    })).toThrow("regular, non-symlink file");

    const broadDirectory = path.join(root, "broad");
    mkdirSync(broadDirectory, { mode: 0o755 });
    expect(() => updateRuntimeEnvFile(path.join(broadDirectory, ".env"), {
      apiKey: "sk-new-1234567890123456",
      tunnelId: "tunnel_wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww"
    })).toThrow("directory permissions are too broad");
  });
});

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "codex-mcp-runtime-env-"));
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
