import * as Sentry from "@sentry/tanstackstart-react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAppOrigin, getAuthBindings, withCfEnv } from "~/server/cf-env";

import { handleHttpRequest } from "./http";
import { forwardToPlaced } from "./placed";
import { handleQueueInvocation } from "./queue";
import { handleScheduledInvocation } from "./scheduled";

const sent: Sentry.ErrorEvent[] = [];
let sentryClient: Sentry.NodeClient | undefined;

function recordSentryEvents() {
  sent.length = 0;
  sentryClient = new Sentry.NodeClient({
    dsn: "https://public@o0.ingest.sentry.io/0",
    stackParser: Sentry.defaultStackParser,
    integrations: [],
    transport: () => ({
      send: async () => ({ statusCode: 200 }),
      flush: async () => true,
    }),
    beforeSend(event) {
      sent.push(event);
      return null;
    },
  });
  Sentry.setCurrentClient(sentryClient);
  sentryClient.init();
}

afterEach(async () => {
  await sentryClient?.close();
  sentryClient = undefined;
  Sentry.getCurrentScope().setClient(undefined);
});

const version = {
  id: "fixture-version",
  tag: "fixture",
  timestamp: "2026-01-01T00:00:00Z",
};
const context = { waitUntil: (_task: Promise<unknown>) => {} };

describe("Worker event composition", () => {
  it("keeps concurrent binding scopes isolated and restores the caller", async () => {
    const outer = getAuthBindings();
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withCfEnv(
      fromPartial<Env>({ APP_ORIGIN: "https://first.example" }),
      async () => {
        await ready;
        return getAppOrigin();
      },
    );
    const second = withCfEnv(
      fromPartial<Env>({ APP_ORIGIN: "https://second.example" }),
      async () => {
        release();
        await Promise.resolve();
        return getAppOrigin();
      },
    );
    expect(await Promise.all([first, second])).toEqual([
      "https://first.example",
      "https://second.example",
    ]);
    expect(getAuthBindings()).toBe(outer);
  });

  it("serves correlated maintenance without database or gateway bindings", async () => {
    const env = fromPartial<Env & { MAINTENANCE_MODE: string }>({
      MAINTENANCE_MODE: "true",
      CF_VERSION_METADATA: version,
    });
    const response = await handleHttpRequest(
      new Request("https://fixture.example/api/operations/entity.list", {
        headers: { "cf-ray": "1234567890abcdef-SJC" },
      }),
      env,
      context,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("1234567890abcdef-SJC");
    expect(response.headers.get("retry-after")).toBe("300");
    expect(await response.json()).toMatchObject({
      error: { code: "MAINTENANCE" },
    });
  });

  it("returns correlated scrubbed diagnostics for dispatch setup failures", async () => {
    const env = fromPartial<Env>({
      CF_VERSION_METADATA: version,
      E2E_AUTH_TEST_MODE: "true",
    });
    Object.defineProperty(env, "HYPERDRIVE", {
      get() {
        throw new Error("SQLSTATE 08006; password=synthetic-credential");
      },
    });
    const response = await handleHttpRequest(
      new Request("https://fixture.example/", {
        headers: { "cf-ray": "1234567890abcdef-SJC" },
      }),
      env,
      context,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("1234567890abcdef-SJC");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("SQLSTATE 08006");
    expect(body).not.toContain("synthetic-credential");
  });

  it("rejects unknown queues without acknowledging their payloads or resolving a DB", async () => {
    let acknowledgements = 0;
    const batch = fromPartial<Parameters<typeof handleQueueInvocation>[0]>({
      queue: "future-queue",
      messages: [
        {
          body: {},
          ack() {
            acknowledgements++;
          },
          retry() {},
        },
      ],
    });
    await expect(
      handleQueueInvocation(
        batch,
        fromPartial<Env>({ CF_VERSION_METADATA: version }),
        context,
      ),
    ).rejects.toThrow("Unexpected queue: future-queue");
    expect(acknowledgements).toBe(0);
  });

  it("rejects background requests without the derived key", async () => {
    const attempts: HeadersInit[] = [
      {},
      { "x-cubby-background-key": "forged" },
    ];
    for (const headers of attempts) {
      const response = await handleHttpRequest(
        new Request("https://fixture.example/__internal/background", {
          method: "POST",
          headers,
          body: "{}",
        }),
        fromPartial<Env>({ BETTER_AUTH_SECRET: "synthetic-secret" }),
        context,
      );
      expect(response.status).toBe(404);
    }
    recordSentryEvents();
    const env = fromPartial<Env>({
      BETTER_AUTH_SECRET: "synthetic-secret",
      CF_VERSION_METADATA: version,
      BACKGROUND_WORKER: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          handleHttpRequest(new Request(input, init), env, context),
      },
    });
    await expect(
      forwardToPlaced(env, {
        event: "queue",
        queue: "future-queue",
        bodies: [],
      }),
    ).rejects.toThrow("Unexpected queue: future-queue");
    await sentryClient?.flush(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.contexts?.background_execution).toEqual({
      event: "queue",
      duration_ms: expect.any(Number),
      execution_outcome: "unknown",
    });
    expect(sent[0]?.exception?.values?.[0]).toMatchObject({
      value: "Unexpected queue: future-queue",
      mechanism: { handled: false, type: "auto.http.cloudflare" },
    });
  });

  it("applies placed outcomes and preserves unknown transport failures without resending", async () => {
    recordSentryEvents();
    const ack = vi.fn();
    const retry = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([{ action: "retry", delaySeconds: 30 }]),
      )
      .mockResolvedValueOnce(
        new Response("synthetic private upstream body", {
          status: 503,
          headers: {
            "x-cubby-placement": "remote",
            "cf-ray": "1234567890abcdef-SJC",
          },
        }),
      )
      .mockRejectedValueOnce(new Error("synthetic transport failure"));
    const env = fromPartial<Env>({
      CF_VERSION_METADATA: version,
      BETTER_AUTH_SECRET: "synthetic-secret",
      BACKGROUND_WORKER: { fetch },
    });
    const batch = {
      queue: "cubby-background",
      messages: [{ body: {}, ack, retry }],
    };
    await handleQueueInvocation(batch, env, context);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    await expect(handleQueueInvocation(batch, env, context)).rejects.toThrow(
      "Background forwarding failed: 503",
    );
    await sentryClient?.flush(1000);
    expect(sent[0]?.contexts?.background_forward).toEqual({
      event: "queue",
      phase: "response",
      status: 503,
      duration_ms: expect.any(Number),
      placement: "remote",
      cf_ray: "1234567890abcdef-SJC",
      execution_outcome: "unknown",
    });
    expect(sent[0]?.exception?.values?.[0]?.mechanism).toMatchObject({
      handled: false,
      type: "auto.faas.cloudflare.queue",
    });
    expect(JSON.stringify(sent)).not.toContain(
      "synthetic private upstream body",
    );
    await expect(handleQueueInvocation(batch, env, context)).rejects.toThrow(
      "synthetic transport failure",
    );
    await sentryClient?.flush(1000);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.contexts?.background_forward).toEqual({
      event: "queue",
      phase: "fetch",
      duration_ms: expect.any(Number),
      execution_outcome: "unknown",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("rejects unexpected schedules before resolving a database", async () => {
    await expect(
      handleScheduledInvocation(
        { scheduledTime: 0, cron: "unexpected" },
        fromPartial<Env>({ CF_VERSION_METADATA: version }),
      ),
    ).rejects.toThrow("Unexpected cron trigger");
  });
});
