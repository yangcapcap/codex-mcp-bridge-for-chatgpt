import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultTunnelProfileMetadataFile,
  expectedTunnelProfileIdentity,
  inspectReusableTunnelProfile,
  recordTunnelProfileMetadata
} from "../scripts/tunnel-profile.mjs";

describe("managed tunnel profile identity", () => {
  it("reuses only the exact recorded profile contents and runtime identity", () => {
    const root = temporaryDirectory();
    const profileFile = path.join(root, "profile.yaml");
    const envFile = path.join(root, ".env");
    const metadataFile = defaultTunnelProfileMetadataFile(envFile, "managed-profile");
    writeFileSync(profileFile, "config_version: 1\ncontrol_plane:\n  tunnel_id: tunnel_one123\n", {
      mode: 0o600
    });
    const run = inventoryRunner(profileFile);
    const identity = expectedTunnelProfileIdentity({
      profile: "managed-profile",
      tunnelId: "tunnel_one123",
      transport: "stdio",
      endpoint: "'/node' '/runtime/dist/stdio.js'",
      runtimeBuildId: "build-one",
      runtimeRoot: "/runtime",
      nodeExecutable: "/node",
      tunnelClient: "/tunnel-client",
      tunnelClientVersion: "run version 1"
    });

    expect(inspectReusableTunnelProfile({
      tunnelClient: "/tunnel-client",
      profile: "managed-profile",
      environment: {},
      cwd: root,
      metadataFile,
      expected: identity,
      run
    })).toMatchObject({ reusable: false, reason: "managed metadata is absent" });

    recordTunnelProfileMetadata({
      tunnelClient: "/tunnel-client",
      profile: "managed-profile",
      environment: {},
      cwd: root,
      metadataFile,
      identity,
      run
    });
    expect(inspectReusableTunnelProfile({
      tunnelClient: "/tunnel-client",
      profile: "managed-profile",
      environment: {},
      cwd: root,
      metadataFile,
      expected: identity,
      run
    })).toMatchObject({ reusable: true, reason: null, profilePath: profileFile });
    expect(JSON.parse(readFileSync(metadataFile, "utf8")).identity).toEqual(identity);

    writeFileSync(profileFile, "config_version: 1\n# externally changed\n", { mode: 0o600 });
    expect(inspectReusableTunnelProfile({
      tunnelClient: "/tunnel-client",
      profile: "managed-profile",
      environment: {},
      cwd: root,
      metadataFile,
      expected: identity,
      run
    })).toMatchObject({ reusable: false, reason: "profile contents changed" });
  });

  it("rejects changed tunnel, transport, command, build, and profile permissions", () => {
    const root = temporaryDirectory();
    const profileFile = path.join(root, "profile.yaml");
    const metadataFile = path.join(root, "metadata", "profile.json");
    writeFileSync(profileFile, "config_version: 1\n", { mode: 0o600 });
    const run = inventoryRunner(profileFile);
    const identity = expectedTunnelProfileIdentity({
      profile: "managed-profile",
      tunnelId: "tunnel_one123",
      transport: "stdio",
      endpoint: "command-one",
      runtimeBuildId: "build-one",
      runtimeRoot: "/runtime/one",
      nodeExecutable: "/node",
      tunnelClient: "/tunnel-client",
      tunnelClientVersion: "version-one"
    });
    recordTunnelProfileMetadata({
      tunnelClient: "/tunnel-client",
      profile: "managed-profile",
      environment: {},
      cwd: root,
      metadataFile,
      identity,
      run
    });

    for (const changed of [
      { ...identity, tunnelId: "tunnel_two123" },
      { ...identity, transport: "http" },
      { ...identity, endpoint: "command-two" },
      { ...identity, runtimeBuildId: "build-two" },
      { ...identity, authentication: "oauth-configuration-digest" },
      { ...identity, runtimeRoot: "/runtime/two" }
    ]) {
      expect(inspectReusableTunnelProfile({
        tunnelClient: "/tunnel-client",
        profile: "managed-profile",
        environment: {},
        cwd: root,
        metadataFile,
        expected: changed,
        run
      })).toMatchObject({ reusable: false, reason: "managed identity changed" });
    }

    chmodSync(profileFile, 0o644);
    expect(inspectReusableTunnelProfile({
      tunnelClient: "/tunnel-client",
      profile: "managed-profile",
      environment: {},
      cwd: root,
      metadataFile,
      expected: identity,
      run
    })).toMatchObject({ reusable: false });
  });
});

function inventoryRunner(profileFile: string) {
  return (_command: string, args: string[]) => {
    if (args[0] === "profiles") {
      return {
        status: 0,
        stdout: JSON.stringify([{ name: "managed-profile", path: profileFile }]),
        stderr: ""
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function temporaryDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-tunnel-profile-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
