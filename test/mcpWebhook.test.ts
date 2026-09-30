import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mock.lookup }));
vi.mock("node:https", () => ({ request: mock.request }));
import { sendPublicWebhook } from "../src/mcpWebhook.js";

afterEach(() => { vi.resetAllMocks(); });

function response(status: number, body = "{}") {
  mock.request.mockImplementation((_url, _options, handler) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const incoming = new EventEmitter() as EventEmitter & { statusCode: number };
      incoming.statusCode = status;
      handler(incoming);
      queueMicrotask(() => { incoming.emit("data", Buffer.from(body)); incoming.emit("end"); });
    };
    return req;
  });
}

describe("public HTTPS webhook socket boundary", () => {
  it("blocks a hostname whose DNS includes any private or metadata-service answer", async () => {
    mock.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(sendPublicWebhook("https://receiver.example.com/private", "{}", {}, AbortSignal.timeout(1_000))).rejects.toThrow("invalid_destination");
    expect(mock.request).not.toHaveBeenCalled();
  });

  it("rechecks DNS on every attempt, pins the socket, and preserves the TLS hostname", async () => {
    mock.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    response(200);
    await expect(sendPublicWebhook("https://receiver.example.com/private", "{}", {}, AbortSignal.timeout(1_000))).resolves.toMatchObject({ status: 200 });
    const [url, options] = mock.request.mock.calls[0];
    expect(url.hostname).toBe("receiver.example.com");
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).not.toBe(false);
    const lookedUp = vi.fn(); options.lookup("receiver.example.com", {}, lookedUp);
    expect(lookedUp).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    await expect(sendPublicWebhook("https://receiver.example.com/private", "{}", {}, AbortSignal.timeout(1_000))).rejects.toThrow("invalid_destination");
    expect(mock.request).toHaveBeenCalledTimes(1);
  });

  it("returns redirects as permanent failures without following them", async () => {
    mock.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]); response(302);
    await expect(sendPublicWebhook("https://receiver.example.com/private", "{}", {}, AbortSignal.timeout(1_000))).resolves.toMatchObject({ status: 302 });
    expect(mock.request).toHaveBeenCalledTimes(1);
  });

  it("bounds DNS stalls and never opens a socket after timeout", async () => {
    mock.lookup.mockReturnValue(new Promise(() => {}));
    await expect(sendPublicWebhook("https://receiver.example.com/private", "{}", {}, AbortSignal.timeout(10))).rejects.toThrow("timeout");
    expect(mock.request).not.toHaveBeenCalled();
  });
});
