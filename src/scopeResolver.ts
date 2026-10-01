import { createHmac, randomBytes } from "node:crypto";
import { SCOPE_ID_PATTERN } from "./sessionRegistry.js";
import type { BridgeStateStore } from "./stateStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

const CHATGPT_CONVERSATION_LINKS_META_KEY = "chatgpt_conversation_links_v1";
const SCOPE_KEY_VERSION = 1;
const SCOPE_ROTATION_POLICY = "manual-state-migration-required" as const;
const MAX_HOST_IDENTIFIER_LENGTH = 4_096;
const MAX_CHATGPT_CONVERSATION_LINKS = 1_000;
const CHATGPT_CONVERSATION_URL_PREFIX = "https://chatgpt.com/c/";

export type ToolCallMetadata = Record<string, unknown> | undefined;

// Classify only errors created here, without reading a caller's error fields or
// invoking a Proxy trap. The diagnostic does not grant routing authority.
const missingScopeErrors = new WeakSet<object>();
export function isMissingConversationScopeError(error: unknown): boolean {
  return (typeof error === "object" && error !== null || typeof error === "function") && missingScopeErrors.has(error as object);
}

export type ScopeResolution = {
  scopeId: string;
  source: "host-metadata" | "explicit-compatibility";
  keyVersion: number;
  explicitInputIgnored: boolean;
  conversationUrl?: string;
};

export type ScopeResolverOptions = {
  stateStore?: BridgeStateStore;
  secret?: Uint8Array;
};

/**
 * Derives an opaque conversation routing key without retaining the host's raw
 * subject or organization identifiers. The host contract defines
 * `openai/session` only as an anonymized correlation value. UUID-shaped values
 * are retained separately as best-effort ChatGPT route candidates for the
 * personal Dashboard; reachability is not guaranteed, arbitrary values are
 * never retained, and scopes observed before this capture cannot be backfilled.
 */
export class ScopeResolver {
  private readonly secret?: Buffer;
  private readonly stateStore?: BridgeStateStore;
  private readonly conversationIds: Map<string, string>;

  constructor(options: ScopeResolverOptions = {}) {
    if (options.secret && options.stateStore) {
      throw new Error("Conversation-scope resolver cannot override persisted HMAC state.");
    }
    this.stateStore = options.stateStore;
    if (options.stateStore) options.stateStore.activeSecurityHmacKey("scope", true);
    else this.secret = options.secret ? validateSecret(Buffer.from(options.secret)) : randomBytes(32);
    this.conversationIds = options.stateStore
      ? loadConversationIds(options.stateStore)
      : new Map();
  }

  get keyVersion(): number {
    return this.stateStore?.activeSecurityHmacKey("scope").generation ?? SCOPE_KEY_VERSION;
  }

  get rotationPolicy(): typeof SCOPE_ROTATION_POLICY {
    return SCOPE_ROTATION_POLICY;
  }

  resolve(metadata: ToolCallMetadata, explicitScopeId?: string): ScopeResolution | undefined {
    const hostIdentity = readHostIdentity(metadata);
    if (hostIdentity) {
      const routing = this.stateStore?.conversationScopeRouting(hostIdentity);
      let scopeId: string;
      if (routing) scopeId = routing.existingCanonicalScopeId ?? routing.activeScopeId;
      else {
        const key = this.stateStore?.activeSecurityHmacKey("scope");
        if (key && key.generation !== 1) throw new Error("Conversation routing generation changed; retry resolution.");
        scopeId = deriveScopeId(key?.secret ?? this.secret!, hostIdentity);
      }
      const conversationId = normalizeChatGptConversationId(hostIdentity.session);
      if (conversationId) this.rememberConversationId(scopeId, conversationId);
      return {
        scopeId,
        source: "host-metadata",
        keyVersion: routing?.activeGeneration ?? SCOPE_KEY_VERSION,
        explicitInputIgnored: explicitScopeId !== undefined,
        ...(conversationId
          ? { conversationUrl: chatGptConversationUrl(conversationId) }
          : {})
      };
    }
    if (explicitScopeId === undefined) return undefined;
    const normalized = explicitScopeId.trim().toLowerCase();
    if (!SCOPE_ID_PATTERN.test(normalized)) {
      throw new Error("Expected a UUID-formatted compatibility scope id.");
    }
    return {
      scopeId: this.stateStore?.canonicalConversationScopeId(normalized) ?? normalized,
      source: "explicit-compatibility",
      keyVersion: this.keyVersion,
      explicitInputIgnored: false
    };
  }

  require(
    metadata: ToolCallMetadata,
    explicitScopeId: string | undefined,
    operation: string
  ): ScopeResolution {
    const resolution = this.resolve(metadata, explicitScopeId);
    if (resolution) return resolution;
    const error = new Error(
      `${operation} requires ChatGPT conversation metadata or an explicit compatibility scopeId from a non-ChatGPT MCP host.`
    );
    missingScopeErrors.add(error);
    throw error;
  }

  conversationUrl(scopeId: string): string | undefined {
    const normalized = scopeId.toLowerCase();
    const canonical = this.stateStore?.canonicalConversationScopeId(normalized) ?? normalized;
    const conversationId = this.conversationIds.get(canonical);
    return conversationId ? chatGptConversationUrl(conversationId) : undefined;
  }

  private rememberConversationId(scopeId: string, conversationId: string): void {
    const existing = this.conversationIds.get(scopeId);
    if (existing === conversationId) return;
    if (existing) {
      throw new Error("A conversation scope resolved to conflicting ChatGPT conversation IDs.");
    }
    this.conversationIds.set(scopeId, conversationId);
    while (this.conversationIds.size > MAX_CHATGPT_CONVERSATION_LINKS) {
      const oldest = this.conversationIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.conversationIds.delete(oldest);
    }
    if (this.stateStore) persistConversationIds(this.stateStore, this.conversationIds);
  }
}

type HostIdentity = {
  organization: string | null;
  subject: string | null;
  session: string;
};

function readHostIdentity(metadata: ToolCallMetadata): HostIdentity | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "openai/session")) return undefined;
  const session = readIdentifier(metadata, "openai/session", true);
  return {
    organization: readIdentifier(metadata, "openai/organization", false),
    subject: readIdentifier(metadata, "openai/subject", false),
    session
  };
}

function readIdentifier(
  metadata: Record<string, unknown>,
  key: string,
  required: true
): string;
function readIdentifier(
  metadata: Record<string, unknown>,
  key: string,
  required: false
): string | null;
function readIdentifier(
  metadata: Record<string, unknown>,
  key: string,
  required: boolean
): string | null {
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
    if (required) throw new Error(`Host metadata ${key} is required for derived scope routing.`);
    return null;
  }
  const value = metadata[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HOST_IDENTIFIER_LENGTH) {
    throw new Error(`Host metadata ${key} must be a non-empty bounded string.`);
  }
  return value;
}

function deriveScopeId(secret: Buffer, identity: HostIdentity): string {
  const digest = createHmac("sha256", secret)
    .update("codex-mcp-bridge/conversation-scope/v1\0")
    .update(JSON.stringify(identity))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeChatGptConversationId(session: string): string | undefined {
  const value = session.trim().toLowerCase();
  return SCOPE_ID_PATTERN.test(value) ? value : undefined;
}

function chatGptConversationUrl(conversationId: string): string {
  return `${CHATGPT_CONVERSATION_URL_PREFIX}${conversationId}`;
}

function loadConversationIds(stateStore: BridgeStateStore): Map<string, string> {
  const encoded = stateStore.getMeta(CHATGPT_CONVERSATION_LINKS_META_KEY);
  if (encoded === undefined) return new Map();
  try {
    const parsed = parseJsonTextStrict(encoded, "Stored ChatGPT conversation links");
    if (!Array.isArray(parsed) || parsed.length > MAX_CHATGPT_CONVERSATION_LINKS) {
      throw new Error("expected a bounded entry array");
    }
    const entries: Array<[string, string]> = parsed.map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string"
      ) {
        throw new Error("expected [scopeId, conversationId] entries");
      }
      const scopeId = entry[0].toLowerCase();
      const conversationId = entry[1].toLowerCase();
      if (!SCOPE_ID_PATTERN.test(scopeId) || !SCOPE_ID_PATTERN.test(conversationId)) {
        throw new Error("expected UUID-formatted scope and conversation IDs");
      }
      return [scopeId, conversationId];
    });
    if (new Set(entries.map(([scopeId]) => scopeId)).size !== entries.length) {
      throw new Error("duplicate conversation scope");
    }
    return new Map(entries);
  } catch (error) {
    throw new Error(
      `Invalid persisted ChatGPT conversation-link index: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function persistConversationIds(
  stateStore: BridgeStateStore,
  conversationIds: ReadonlyMap<string, string>
): void {
  stateStore.setMeta(
    CHATGPT_CONVERSATION_LINKS_META_KEY,
    JSON.stringify([...conversationIds])
  );
}


function validateSecret(secret: Buffer): Buffer {
  if (secret.length !== 32) throw new Error("Conversation-scope HMAC key must contain exactly 32 bytes.");
  return Buffer.from(secret);
}
