import { problemsCountSchema } from "@cubby/schemas/problems";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import { runWithExecutionCtx } from "~/server/cf-env";

import {
  readDashboardCountsSnapshot,
  readDatabaseFreshness,
  readProblemCountsFromDurableObject,
  recordDatabaseWrite,
} from "./client";
import { databaseFreshness } from "./state";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("freshness RPC failure policy", () => {
  it("fails reads closed and never rejects a committed write notification", async () => {
    const port = {
      readFreshness: vi.fn().mockRejectedValue(new Error("offline")),
      recordWrite: vi.fn().mockRejectedValue(new Error("offline")),
    };
    expect(await readDatabaseFreshness(port)).toBeNull();
    await expect(
      recordDatabaseWrite("test.mutation", port),
    ).resolves.toBeUndefined();
  });
  it("bounds an unresponsive RPC to one second", async () => {
    vi.useFakeTimers();
    const port = {
      readFreshness: () =>
        new Promise<ReturnType<typeof databaseFreshness>>(() => {}),
      recordWrite: async () => databaseFreshness(0),
    };
    const read = readDatabaseFreshness(port);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await read).toBeNull();
  });

  it("falls back to direct reads when the dashboard snapshot fails", async () => {
    expect(
      await readDashboardCountsSnapshot({
        getDashboardCounts: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeNull();
  });

  it("serves a validated problem-count edge hit without a second Durable Object RPC", async () => {
    const counts = mock(problemsCountSchema, { seed: 31 });
    const getProblemCounts = vi.fn().mockResolvedValue(counts);
    let cached: Response | undefined;
    const put = vi.fn(async (_key: RequestInfo | URL, response: Response) => {
      cached = response;
    });
    vi.stubGlobal("caches", {
      default: {
        match: async () => cached?.clone(),
        put,
      },
    });
    const pending: Promise<unknown>[] = [];

    await runWithExecutionCtx(
      { waitUntil: (promise) => pending.push(promise) },
      async () => {
        expect(
          await readProblemCountsFromDurableObject({ getProblemCounts }),
        ).toEqual(counts);
        await Promise.all(pending);
        expect(
          await readProblemCountsFromDurableObject({ getProblemCounts }),
        ).toEqual(counts);
        expect(getProblemCounts).toHaveBeenCalledOnce();
        cached = new Response('{"total":"invalid"}');
        expect(
          await readProblemCountsFromDurableObject({ getProblemCounts }),
        ).toEqual(counts);
      },
      "https://cubby.example",
    );

    expect(getProblemCounts).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    expect(cached?.headers.get("Cache-Control")).toBe("public, max-age=10");
  });
});
