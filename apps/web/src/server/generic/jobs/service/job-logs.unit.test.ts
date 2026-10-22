import { describe, expect, it } from "vitest";

import {
  type LogDeps,
  queryJobLogs,
  WORKERS_LOGS_RETENTION_MS,
} from "./job-logs";

const now = Date.parse("2026-03-02T12:00:00Z");
const window = {
  id: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  state: "running",
  createdAt: new Date(now - 10 * 60_000),
  updatedAt: new Date(now - 60_000),
};
const deps = (patch: Partial<LogDeps>): LogDeps => ({
  token: "synthetic-token",
  fetch: () => Promise.reject(new Error("unexpected fetch")),
  now: () => now,
  ...patch,
});

describe("queryJobLogs", () => {
  it("reports a missing token as not configured without querying", async () => {
    await expect(
      queryJobLogs(window, deps({ token: undefined })),
    ).resolves.toMatchObject({
      status: "not_configured",
    });
  });

  it("reports a window older than retention as expired", async () => {
    const old = {
      ...window,
      state: "completed",
      createdAt: new Date(now - WORKERS_LOGS_RETENTION_MS - 3_600_000),
      updatedAt: new Date(now - WORKERS_LOGS_RETENTION_MS - 1_800_000),
    };
    await expect(queryJobLogs(old, deps({}))).resolves.toMatchObject({
      status: "expired",
    });
  });

  it("filters by the Job and its Run and returns lines oldest first", async () => {
    let body: unknown;
    const result = await queryJobLogs(
      window,
      deps({
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              result: {
                events: {
                  count: 2,
                  events: [
                    {
                      $metadata: {
                        id: "b",
                        message: "[jobs] page done",
                        level: "log",
                      },
                      timestamp: now - 2_000,
                      source: {
                        message: "[jobs] page done",
                        level: "log",
                        scope: "jobs",
                        stepKey: "orphans",
                      },
                    },
                    {
                      $metadata: {
                        id: "a",
                        message: "[jobs] claimed",
                        level: "info",
                      },
                      timestamp: now - 5_000,
                      source: "[jobs] claimed",
                    },
                  ],
                },
              },
            }),
          );
        },
      }),
    );
    expect(body).toMatchObject({
      view: "events",
      parameters: {
        filterCombination: "or",
        filters: [
          { key: "jobId", operation: "eq", value: window.id },
          { key: "runId", operation: "eq", value: window.runId },
        ],
      },
    });
    expect(result).toMatchObject({
      status: "ok",
      count: 2,
      lines: [
        { id: "a", level: "info", message: "[jobs] claimed", fields: null },
        { id: "b", level: "info", fields: '{"stepKey":"orphans"}' },
      ],
    });
  });

  it("returns a failed query as raw scrubbed diagnostics", async () => {
    const result = await queryJobLogs(
      window,
      deps({
        fetch: async () =>
          new Response('{"errors":[{"message":"Authentication error"}]}', {
            status: 403,
            statusText: "Forbidden",
          }),
      }),
    );
    expect(result).toMatchObject({
      status: "error",
      request: expect.stringContaining("403 Forbidden"),
      message: expect.stringContaining("Authentication error"),
    });
  });
});
