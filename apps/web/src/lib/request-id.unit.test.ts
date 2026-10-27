import superjson from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWithRequestDiagnostics,
  getBrowserRequestDiagnostics,
  REQUEST_ID_HEADER,
} from "./request-id";

describe("request correlation header", () => {
  it("retains response headers and causes when the HTTP error body disconnects", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("Synthetic response disconnected"));
      },
    });
    await expect(
      fetchWithRequestDiagnostics(
        async () =>
          new Response(body, {
            status: 503,
            headers: { "cf-ray": "synthetic-body-ray" },
          }),
        "/api/operations/workQueue.queue",
        undefined,
        { operation: "workQueue.queue" },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Synthetic response disconnected"),
      data: {
        requestId: "synthetic-body-ray",
        diagnostics: {
          cfRayId: "synthetic-body-ray",
          causes: [{ message: "Synthetic response disconnected" }],
          http: { status: 503, elapsedMs: expect.any(Number) },
        },
      },
    });
  });

  it("scrubs escaped upstream credential strings in messages and copied raw bodies", async () => {
    const body = JSON.stringify({
      code: "UPSTREAM_ERROR",
      message: 'failure: {"password":"synthetic-secret"}',
    });
    const error = await fetchWithRequestDiagnostics(
      async () => new Response(body, { status: 502 }),
      "/api/operations/workQueue.queue",
      undefined,
      { operation: "workQueue.queue" },
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      message: expect.stringContaining("[REDACTED]"),
      data: { code: "UPSTREAM_ERROR" },
    });
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  });
  afterEach(() => vi.unstubAllGlobals());
  it("uses a neutral request-id header", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  // Edge failures can bypass the application entirely; preserve the evidence
  // rather than inventing an application error or dropping the response body.
  it("retains full HTTP failure bodies and Cloudflare-only correlation", async () => {
    const body = `upstream unavailable\n${"diagnostic ".repeat(300)}\nSQLSTATE 53300`;
    await expect(
      fetchWithRequestDiagnostics(
        async () =>
          new Response(body, {
            status: 503,
            headers: { "cf-ray": "synthetic-ray-SJC" },
          }),
        "/api/operations/workQueue.queue",
        { headers: { "x-cubby-operation": "workQueue.queue" } },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("SQLSTATE 53300"),
      data: {
        code: "HTTP_ERROR",
        diagnostics: {
          operation: "workQueue.queue",
          stage: "http",
          cfRayId: "synthetic-ray-SJC",
          http: { status: 503, body },
        },
      },
    });
  });

  it("identifies an empty edge response without inventing server causes", async () => {
    await expect(
      fetchWithRequestDiagnostics(
        async () =>
          new Response(null, {
            status: 503,
            headers: { "cf-ray": "synthetic-empty-SJC" },
          }),
        "/api/operations/workQueue.queue",
        { headers: { "x-cubby-operation": "workQueue.queue" } },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("empty response body"),
      data: {
        code: "HTTP_ERROR",
        diagnostics: {
          stage: "http",
          causes: [],
          http: { status: 503, body: "", elapsedMs: expect.any(Number) },
        },
      },
    });
  });

  it("preserves a structured server refusal instead of replacing it with HTTP_ERROR", async () => {
    const error = {
      code: "FORBIDDEN",
      message: "Synthetic write refused",
      requestId: "server-request",
      diagnostics: {
        origin: "server",
        operation: "entity.list",
        stage: "run",
        causes: [{ name: "Error", message: "Original SQLSTATE 42501" }],
      },
    };
    await expect(
      fetchWithRequestDiagnostics(
        async () =>
          // The operation route's shape: the bare error, superjson-encoded.
          Response.json(superjson.serialize(error), { status: 403 }),
        "/api/operations/entity.list",
        { headers: { "x-cubby-operation": "entity.list" } },
      ),
    ).rejects.toMatchObject({
      message: error.message,
      data: {
        ...error,
        diagnostics: {
          ...error.diagnostics,
          http: { status: 403 },
        },
      },
    });
  });

  it("preserves fallback server references when Start receives an opaque HTTP failure", async () => {
    await expect(
      fetchWithRequestDiagnostics(
        async () =>
          new Response("opaque", {
            status: 500,
            headers: {
              "x-request-id": "sample-ray",
              "x-sentry-event-id": "sample-event",
            },
          }),
        "/_serverFn/dispatch",
        { headers: { "x-cubby-operation": "entity.list" } },
      ),
    ).rejects.toMatchObject({
      message: "HTTP 500: opaque",
      data: {
        requestId: "sample-ray",
        diagnostics: { origin: "server", sentryEventId: "sample-event" },
      },
    });
  });

  it("keeps out-of-order response ids paired with their own operations", async () => {
    vi.stubGlobal("window", {});
    const pending = new Map<string, (response: Response) => void>();
    const fetchImpl: typeof fetch = (_input, init) => {
      const operation = new Headers(init?.headers).get("x-cubby-operation")!;
      return new Promise<Response>((resolve) =>
        pending.set(operation, resolve),
      );
    };

    const first = fetchWithRequestDiagnostics(fetchImpl, "/_serverFn/first", {
      headers: { "x-cubby-operation": "entity.detail" },
    });
    const second = fetchWithRequestDiagnostics(fetchImpl, "/_serverFn/second", {
      headers: { "x-cubby-operation": "entity.list" },
    });
    pending.get("entity.list")!(
      new Response(null, { headers: { "x-request-id": "ray-list" } }),
    );
    pending.get("entity.detail")!(
      new Response(null, { headers: { "x-request-id": "ray-detail" } }),
    );
    await Promise.all([first, second]);

    expect(getBrowserRequestDiagnostics().slice(-2)).toEqual([
      expect.objectContaining({
        operation: "entity.list",
        requestId: "ray-list",
      }),
      expect.objectContaining({
        operation: "entity.detail",
        requestId: "ray-detail",
      }),
    ]);
  });
});
