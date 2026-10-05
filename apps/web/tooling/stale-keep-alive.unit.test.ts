import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { request } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { retryStaleKeepAlive } from "./stale-keep-alive";

// Deterministic stand-in for workerd's 5s keep-alive close: the server drops
// a request that arrives on a reused connection without answering it, the
// way a request sent as workerd closes the idle socket is lost.
let server: http.Server;
let origin: string;
const handled: string[] = [];

beforeAll(async () => {
  const served = new WeakSet<Socket>();
  server = http.createServer((req, res) => {
    if (served.has(req.socket)) {
      req.socket.destroy();
      return;
    }
    served.add(req.socket);
    handled.push(`${req.method} ${req.url}`);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("retryStaleKeepAlive", () => {
  it("lets an unwrapped request context fail the way CI E2E did", async () => {
    const api = await request.newContext({ baseURL: origin });
    await api.get("/warm");
    await expect(api.get("/reused")).rejects.toThrow(
      /socket hang up|ECONNRESET/,
    );
    await api.dispose();
  });

  it("retries an idempotent request lost on a reused socket", async () => {
    const api = await request.newContext({ baseURL: origin });
    retryStaleKeepAlive(api);
    await api.get("/warm");
    expect((await api.get("/reused")).ok()).toBe(true);
    expect((await api.delete("/reused-delete")).ok()).toBe(true);
    await api.dispose();
  });

  it("never replays a non-idempotent request", async () => {
    const api = await request.newContext({ baseURL: origin });
    retryStaleKeepAlive(api);
    await api.get("/warm");
    await expect(api.post("/reused-post", { data: {} })).rejects.toThrow(
      /socket hang up|ECONNRESET/,
    );
    expect(handled).not.toContain("POST /reused-post");
    await api.dispose();
  });
});
