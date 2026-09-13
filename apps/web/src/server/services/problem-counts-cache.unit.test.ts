import { problemsCountSchema } from "@cubby/schemas/problems";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectedProblemKeys } from "~/entities/problem-registry";
import type { ProblemCountsCacheAdapter } from "~/server/cf-env";
import { UPCLookupClient } from "~/server/clients/upc-lookup";
import { Database } from "~/server/db";

import {
  getCachedProblemCounts,
  markProblemCountsDirty,
  type ProblemCountsPort,
  refreshCachedProblemCounts,
} from "./problem-counts-cache";

const countProblems = vi.fn<ProblemCountsPort["countProblems"]>();
const port: ProblemCountsPort = { countProblems };

const counts = (total: number) =>
  problemsCountSchema.parse({
    total,
    coverageTotal: total + 1,
    byType: Object.fromEntries(expectedProblemKeys.map((key) => [key, 0])),
  });

function memoryCache(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set("problem-counts:v1", initial);
  const adapter: ProblemCountsCacheAdapter = {
    get: vi.fn(async (key) => values.get(key) ?? null),
    put: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
  };
  return { adapter, values };
}

describe("problem-counts KV snapshot", () => {
  const db = new Database(() => {
    throw new Error(
      "The injected problem count port must not access the database",
    );
  });
  const upc = new UPCLookupClient("https://upc.example");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    countProblems.mockReset();
  });

  it("returns a valid KV hit without running detectors", async () => {
    const cached = counts(7);
    const { adapter } = memoryCache(
      JSON.stringify({
        version: 1,
        counts: cached,
        computedAt: "2026-08-20T17:00:00.000Z",
        coveredThrough: "2026-08-20T16:59:00.000Z",
      }),
    );
    await expect(
      getCachedProblemCounts(db, upc, adapter, port),
    ).resolves.toEqual(cached);
    expect(countProblems).not.toHaveBeenCalled();
  });

  it.each([
    ["miss", undefined],
    [
      "invalid version",
      JSON.stringify({
        version: 2,
        counts: counts(1),
        computedAt: "2026-08-20T17:00:00.000Z",
        coveredThrough: "2026-08-20T17:00:00.000Z",
      }),
    ],
  ])("computes once and seeds KV on %s", async (_label, initial) => {
    const fresh = counts(9);
    countProblems.mockResolvedValue(fresh);
    const { adapter, values } = memoryCache(initial);
    await expect(
      getCachedProblemCounts(db, upc, adapter, port),
    ).resolves.toEqual(fresh);
    expect(countProblems).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get("problem-counts:v1") ?? "null")).toMatchObject(
      {
        version: 1,
        counts: fresh,
        computedAt: "2026-08-20T18:00:00.000Z",
      },
    );
  });

  it("skips an older queued refresh covered by the current snapshot", async () => {
    const { adapter } = memoryCache(
      JSON.stringify({
        version: 1,
        counts: counts(4),
        computedAt: "2026-08-20T17:30:00.000Z",
        coveredThrough: "2026-08-20T17:29:00.000Z",
      }),
    );
    await expect(
      refreshCachedProblemCounts(
        db,
        upc,
        adapter,
        "2026-08-20T17:00:00.000Z",
        port,
      ),
    ).resolves.toBe("skipped");
    expect(countProblems).not.toHaveBeenCalled();
  });

  it("runs a later queued refresh and advances coveredThrough", async () => {
    const fresh = counts(8);
    countProblems.mockResolvedValue(fresh);
    const { adapter, values } = memoryCache(
      JSON.stringify({
        version: 1,
        counts: counts(4),
        computedAt: "2026-08-20T17:30:00.000Z",
        coveredThrough: "2026-08-20T17:29:00.000Z",
      }),
    );
    await expect(
      refreshCachedProblemCounts(
        db,
        upc,
        adapter,
        "2026-08-20T18:00:00.000Z",
        port,
      ),
    ).resolves.toBe("succeeded");
    expect(countProblems).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get("problem-counts:v1") ?? "null")).toMatchObject(
      {
        counts: fresh,
        coveredThrough: "2026-08-20T18:00:00.000Z",
      },
    );
  });

  it("returns a cold live result when seeding KV fails", async () => {
    const fresh = counts(11);
    countProblems.mockResolvedValue(fresh);
    const { adapter } = memoryCache();
    vi.mocked(adapter.put).mockRejectedValue(new Error("KV unavailable"));
    await expect(
      getCachedProblemCounts(db, upc, adapter, port),
    ).resolves.toEqual(fresh);
  });

  it("preserves the last valid snapshot when a refresh fails", async () => {
    const previous = JSON.stringify({
      version: 1,
      counts: counts(5),
      computedAt: "2026-08-20T17:30:00.000Z",
      coveredThrough: "2026-08-20T17:29:00.000Z",
    });
    const { adapter, values } = memoryCache(previous);
    countProblems.mockRejectedValue(new Error("detector failed"));

    await expect(
      refreshCachedProblemCounts(
        db,
        upc,
        adapter,
        "2026-08-20T18:00:00.000Z",
        port,
      ),
    ).rejects.toThrow("detector failed");
    expect(values.get("problem-counts:v1")).toBe(previous);
    expect(adapter.put).not.toHaveBeenCalled();
  });

  describe("dirty mark", () => {
    const snapshot = (coveredThrough: string) =>
      JSON.stringify({
        version: 1,
        counts: counts(4),
        computedAt: coveredThrough,
        coveredThrough,
      });

    it("serves the snapshot and refreshes once when a mutation marked it dirty", async () => {
      const fresh = counts(11);
      countProblems.mockResolvedValue(fresh);
      const { adapter, values } = memoryCache(
        snapshot("2026-08-20T17:00:00.000Z"),
      );
      await markProblemCountsDirty(
        adapter,
        new Date("2026-08-20T17:30:00.000Z"),
      );

      // Outside a Worker request there is no waitUntil: the refresh runs inline
      // after the read decided to serve the old snapshot.
      await expect(
        getCachedProblemCounts(db, upc, adapter, port),
      ).resolves.toEqual(counts(4));
      expect(countProblems).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(values.get("problem-counts:v1") ?? "null"),
      ).toMatchObject({
        counts: fresh,
        coveredThrough: "2026-08-20T17:30:00.000Z",
      });
      expect(adapter.put).toHaveBeenCalledWith(
        "problem-counts:refreshing",
        "2026-08-20T17:30:00.000Z",
        { expirationTtl: 60 },
      );
    });

    it("coalesces a burst: a held lock means no second detector pass", async () => {
      countProblems.mockResolvedValue(counts(11));
      const { adapter, values } = memoryCache(
        snapshot("2026-08-20T17:00:00.000Z"),
      );
      values.set("problem-counts:refreshing", "2026-08-20T17:30:00.000Z");
      await markProblemCountsDirty(
        adapter,
        new Date("2026-08-20T17:31:00.000Z"),
      );
      await expect(
        getCachedProblemCounts(db, upc, adapter, port),
      ).resolves.toEqual(counts(4));
      expect(countProblems).not.toHaveBeenCalled();
    });

    it("ignores a mark older than the snapshot's horizon", async () => {
      const { adapter } = memoryCache(snapshot("2026-08-20T17:30:00.000Z"));
      await markProblemCountsDirty(
        adapter,
        new Date("2026-08-20T17:00:00.000Z"),
      );
      await expect(
        getCachedProblemCounts(db, upc, adapter, port),
      ).resolves.toEqual(counts(4));
      expect(countProblems).not.toHaveBeenCalled();
    });
  });
});
