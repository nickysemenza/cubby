import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { getAppOrigin, getAuthBindings, withCfEnv } from "~/server/cf-env";

import { handleHttpRequest } from "./http";
import { handleQueueInvocation } from "./queue";
import { handleScheduledInvocation } from "./scheduled";

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
      new Request("https://fixture.example/api/v1/entity/list", {
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

  it("rejects unexpected schedules before resolving a database", async () => {
    await expect(
      handleScheduledInvocation(
        { scheduledTime: 0, cron: "unexpected" },
        fromPartial<Env>({ CF_VERSION_METADATA: version }),
      ),
    ).rejects.toThrow("Unexpected cron trigger");
  });
});
