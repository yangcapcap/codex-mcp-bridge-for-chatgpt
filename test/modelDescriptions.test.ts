import { COGATE_UNIFIED_SCHEMA_TABLES } from "../src/cogateUnifiedSchema.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { V24_DECISION_CARD_MIGRATION_SCHEMA } from "../src/decisionCardStore.js";
import {
  MAX_MODEL_DESCRIPTION_LENGTH,
  modelDescriptionProjection,
  normalizeModelDescriptionOverrides
} from "../src/modelDescriptions.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { SETTINGS_REVISION_CONFLICT, UserSettingsStore } from "../src/userSettings.js";
import { replaceStoredSettingsPayloadForTest } from "./helpers/sqliteSettings.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const config = () => loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" });

describe("user model descriptions", () => {
  it("stores only overrides, preserves them across restart and mode changes, and restores to current catalog text", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "model-descriptions-"));
    directories.push(directory);
    const databaseFile = path.join(directory, "state.sqlite");
    const firstState = new BridgeStateStore({ file: databaseFile });
    const store = new UserSettingsStore(config(), { stateStore: firstState });
    const automatic = store.current.modelPolicy;
    const description = "  Use for a bounded change.\nKeep the result concise.  ";
    store.update({ modelDescriptionOverrides: { "model-a": description, "temporarily-unavailable": "Keep this." } }, 0);
    firstState.close();
    const restartedState = new BridgeStateStore({ file: databaseFile });
    const restarted = new UserSettingsStore(config(), { stateStore: restartedState });
    expect(restarted.current.modelDescriptionOverrides).toEqual({
      "model-a": description.trim(), "temporarily-unavailable": "Keep this."
    });
    expect(restarted.modelDescriptionHistory("model-a").versions.map((entry) => entry.description))
      .toEqual([description.trim()]);
    const model = { id: "model-a", description: "New official description" };
    expect(modelDescriptionProjection(model, restarted.current.modelDescriptionOverrides, true)).toEqual({
      description: description.trim(), descriptionSource: "user"
    });
    restarted.update({ modelPolicy: { mode: "fixed", selection: { model: "model-a", reasoningEffort: "medium" }, constraints: { allowDelegation: false } } }, 1);
    expect(modelDescriptionProjection(model, restarted.current.modelDescriptionOverrides, false)).toEqual({ description: model.description });
    restarted.update({ modelPolicy: automatic }, 2);
    expect(restarted.current.modelDescriptionOverrides["model-a"]).toBe(description.trim());
    expect(restarted.modelDescriptionHistory("model-a").versions).toHaveLength(1);
    restarted.update({ modelDescriptionOverrides: { "model-a": " \n\t", "temporarily-unavailable": "Keep this." } }, 3);
    expect(modelDescriptionProjection(model, restarted.current.modelDescriptionOverrides, true)).toEqual({ description: model.description });
    expect(readFileSync(databaseFile).includes(Buffer.from(model.description))).toBe(false);
    expect(restarted.current.modelDescriptionOverrides).toEqual({ "temporarily-unavailable": "Keep this." });
    expect(restarted.modelDescriptionHistory("model-a").versions.map((entry) => entry.description))
      .toEqual([null, description.trim()]);
    restartedState.close();
  });

  it("loads older settings without copying a catalog description or advancing the settings revision", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "model-descriptions-legacy-"));
    directories.push(directory);
    const databaseFile = path.join(directory, "state.sqlite");
    const firstState = new BridgeStateStore({ file: databaseFile });
    const store = new UserSettingsStore(config(), { stateStore: firstState });
    store.update({ uiLocalePreference: "ko" }, 0);
    const saved = firstState.getSettingsRecord()!.payload as Record<string, unknown>;
    delete saved.modelDescriptionOverrides;
    firstState.close();
    replaceStoredSettingsPayloadForTest(databaseFile, saved);
    const restartedState = new BridgeStateStore({ file: databaseFile });
    const restarted = new UserSettingsStore(config(), { stateStore: restartedState });
    expect(restarted.current.modelDescriptionOverrides).toEqual({});
    expect(restarted.current.settingsRevision).toBe(1);
    restartedState.close();
  });

  it("enforces stale-write conflicts and keeps execution references independent of descriptions", () => {
    const store = new UserSettingsStore(config());
    const executionRef = store.executionPolicyRef();
    const envelopeRef = store.taskExecutionEnvelopeRef();
    store.update({ modelDescriptionOverrides: { "model-a": "First." } }, 0);
    expect(store.executionPolicyRef()).toBe(executionRef);
    expect(store.taskExecutionEnvelopeRef()).toBe(envelopeRef);
    expect(() => store.update({ modelDescriptionOverrides: { "model-a": "Stale." } }, 0)).toThrow(SETTINGS_REVISION_CONFLICT);
    expect(store.modelDescriptionHistory("model-a").versions.map((entry) => entry.description))
      .toEqual(["First."]);
    const read = store.current;
    read.modelDescriptionOverrides["model-a"] = "Mutated snapshot";
    expect(store.current.modelDescriptionOverrides["model-a"]).toBe("First.");
    store.update({ uiLocalePreference: "ko" }, 1);
    expect(store.current.modelDescriptionOverrides["model-a"]).toBe("First.");
    store.reset(2);
    expect(store.current.modelDescriptionOverrides).toEqual({});
  });

  it("normalizes whitespace and rejects malformed or oversized text without altering saved settings", () => {
    expect(normalizeModelDescriptionOverrides({ b: " \n", a: "  Example\ntext  " })).toEqual({ a: "Example\ntext" });
    for (const value of [null, [], { a: 42 }, { "": "text" }, { " a": "text" }, { "a\0b": "text" }, { a: "x".repeat(MAX_MODEL_DESCRIPTION_LENGTH + 1) }]) {
      expect(() => normalizeModelDescriptionOverrides(value)).toThrow(/MODEL_DESCRIPTION/);
    }
    expect(() => normalizeModelDescriptionOverrides(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), "text"])))).toThrow("MODEL_DESCRIPTIONS_LIMIT");
    expect(() => normalizeModelDescriptionOverrides(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i), "한".repeat(2_000)])))).toThrow("MODEL_DESCRIPTIONS_LIMIT");
    const hostile = normalizeModelDescriptionOverrides(JSON.parse('{"__proto__":"User text","constructor":"Another model"}'));
    expect(modelDescriptionProjection({ id: "__proto__" }, hostile, true).description).toBe("User text");
    expect(modelDescriptionProjection({ id: "toString" }, hostile, true)).toEqual({});
  });

  it("records changed text, official selection, reset and rollback as per-model versions", () => {
    let now = 1_700_000_000_000;
    const state = new BridgeStateStore({ file: ":memory:" });
    const store = new UserSettingsStore(config(), { stateStore: state, now: () => now });
    const save = (description: string | null) => {
      const overrides = description === null ? {} : { "model-a": description };
      store.update({ modelDescriptionOverrides: overrides }, store.current.settingsRevision);
      now += 1_000;
    };
    save("First");
    save("First");
    expect(store.modelDescriptionHistory("model-a").versions).toHaveLength(1);
    save("Second");
    save(null);
    expect(store.modelDescriptionHistoryIds).toEqual(["model-a"]);
    expect(store.modelDescriptionHistory("model-a", undefined, 2)).toEqual({
      kind: "model-description-history", modelId: "model-a",
      versions: [
        { version: 3, description: null, createdAt: new Date(1_700_000_003_000).toISOString() },
        { version: 2, description: "Second", createdAt: new Date(1_700_000_002_000).toISOString() }
      ],
      nextBeforeVersion: 2
    });
    expect(store.modelDescriptionHistory("model-a", 2).versions).toEqual([
      { version: 1, description: "First", createdAt: new Date(1_700_000_000_000).toISOString() }
    ]);
    save("First");
    store.reset(store.current.settingsRevision);
    expect(store.current.modelDescriptionOverrides).toEqual({});
    expect(store.modelDescriptionHistory("model-a").versions.map((entry) => entry.description))
      .toEqual([null, "First", null, "Second", "First"]);
    expect(modelDescriptionProjection({ id: "model-a", description: "Live official" }, store.current.modelDescriptionOverrides, true))
      .toEqual({ description: "Live official" });
    state.close();
  });

  it("rolls back both active settings and history if recording fails", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "model-descriptions-atomic-"));
    directories.push(directory);
    const file = path.join(directory, "state.sqlite");
    const state = new BridgeStateStore({ file });
    const store = new UserSettingsStore(config(), { stateStore: state });
    store.update({ modelDescriptionOverrides: { "model-a": "First" } }, 0);
    const database = new Database(file);
    database.exec(`CREATE TRIGGER reject_model_description_version BEFORE INSERT ON model_description_versions
      WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'history insert rejected'); END`);
    database.close();
    expect(() => store.update({ modelDescriptionOverrides: { "model-a": "Second" } }, 1))
      .toThrow("history insert rejected");
    expect(store.current.settingsRevision).toBe(1);
    expect(store.current.modelDescriptionOverrides).toEqual({ "model-a": "First" });
    expect(store.modelDescriptionHistory("model-a").versions.map((entry) => entry.description)).toEqual(["First"]);
    state.close();
  });

  it("imports only the current override as version one when upgrading a schema-25 database", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "model-descriptions-upgrade-"));
    directories.push(directory);
    const file = path.join(directory, "state.sqlite");
    const state = new BridgeStateStore({ file });
    const store = new UserSettingsStore(config(), { stateStore: state });
    store.update({ modelDescriptionOverrides: { "model-a": "Saved before versions" } }, 0);
    state.close();
    const database = new Database(file);
    database.exec(V24_DECISION_CARD_MIGRATION_SCHEMA);
    for (const table of [...COGATE_UNIFIED_SCHEMA_TABLES].reverse()) {
      database.exec(`DROP TABLE ${table}`);
    }
    database.exec("ALTER TABLE sessions DROP COLUMN auth_boundary");
    database.exec(`DROP TABLE model_description_versions;
      UPDATE bridge_meta SET value='25' WHERE key='schema_version';
      DELETE FROM bridge_meta WHERE key IN ('schema_v26_created_at','schema_v27_created_at','schema_v30_created_at');`);
    database.close();
    const upgradedState = new BridgeStateStore({ file });
    const upgraded = new UserSettingsStore(config(), { stateStore: upgradedState });
    expect(upgradedState.schemaVersion).toBe(31);
    expect(existsSync(`${file}.pre-v25-to-v31.sqlite`)).toBe(true);
    expect(upgraded.current.modelDescriptionOverrides).toEqual({ "model-a": "Saved before versions" });
    expect(upgraded.modelDescriptionHistory("model-a").versions).toEqual([
      { version: 1, description: "Saved before versions", createdAt: null }
    ]);
    upgradedState.close();
  });
});
