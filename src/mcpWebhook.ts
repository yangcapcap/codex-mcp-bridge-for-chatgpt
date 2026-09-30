import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";

export type WebhookResponse = { status: number; body: string };
export type WebhookSender = (url: string, body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<WebhookResponse>;

export function validateCallbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_destination"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.port && url.port !== "443" || value.length > 4_096) throw new Error("invalid_destination");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error("invalid_destination");
  if (!hostname.includes(".") && !isIP(hostname) || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname === "localhost") throw new Error("invalid_destination");
  return url;
}

export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== "unicast") return false;
    // IPv6 global unicast only; deny mapped, transition and special networks.
    return parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3);
  } catch { return false; }
}

/** DNS is resolved on every connection, all answers must be public, and the
 * chosen answer is pinned to the socket. TLS still validates the original
 * hostname. Redirects are returned as failures and are never followed. */
export const sendPublicWebhook: WebhookSender = async (value, body, headers, signal) => {
  const url = validateCallbackUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await new Promise<Awaited<ReturnType<typeof resolveAddresses>>>((resolve, reject) => {
    const abort = () => reject(new Error("timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void resolveAddresses(hostname).then(resolve, () => reject(new Error("destination_unavailable")))
      .finally(() => signal.removeEventListener("abort", abort));
  });
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new Error("invalid_destination");
  const destination = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST", agent: false, signal,
      headers: { ...headers, "content-length": String(Buffer.byteLength(body, "utf8")) },
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, [destination]);
        else callback(null, destination.address, destination.family);
      }
    }, response => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 8_192) { response.destroy(); reject(new Error("response_too_large")); }
        else chunks.push(chunk);
      });
      response.once("error", () => reject(new Error("destination_unavailable")));
      response.once("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", () => reject(new Error(signal.aborted ? "timeout" : "destination_unavailable")));
    req.end(body);
  });
};

async function resolveAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : lookup(hostname, { all: true, verbatim: true });
}

export function validateSigningSecret(secret: string): void {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("invalid_secret");
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("invalid_secret");
}

export function signedHeaders(id: string, subscriptionId: string, body: string, secrets: string[], now = Date.now()): Record<string, string> {
  if (Buffer.byteLength(body, "utf8") > 262_144) throw new Error("payload_too_large");
  const date = new Date(now);
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(now / 1_000)),
    "webhook-signature": secrets.map(secret => new Webhook(secret).sign(id, date, body)).join(" "),
    "X-MCP-Subscription-Id": subscriptionId
  };
}

/** The installation's existing bearer credential stays outside SQLite and is
 * distinct from Codex execution authentication. Token rotation revokes old
 * subscriptions. A DB-only dump cannot disclose callbacks or webhook keys. */
export class EventDestinationVault {
  private readonly key: Buffer;
  constructor(token: string) { this.key = scryptSync(token, "codex-mcp-bridge/mcp-events/v1", 32); }
  seal(id: string, value: EventDestination): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }
  open(id: string, value: string): EventDestination {
    const bytes = Buffer.from(value, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  }
}

export type EventDestination = { url: string; secret: string; previousSecret?: string; rotateUntil?: number };
