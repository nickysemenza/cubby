import { describe, expect, it } from "vitest";

import { measurePage } from "~/server/generic/jobs/page-work";

import {
  beginDatabaseAcquire,
  beginDatabaseQuery,
  withDatabaseRequestMetrics,
  withDatabaseOperationMetrics,
} from "./db-observability";

// Failures: a request collector may omit auth/setup SQL, count nested phase
// totals twice, or lose summaries when the request throws.
describe("database operation metrics", () => {
  it("attributes repeated and nested page queries without inflating the page total", async () => {
    const { sample } = await measurePage(async (work) => {
      await work.time("preparation", async () => {
        beginDatabaseQuery(0)(1);
        await work.time("discovery", async () => {
          beginDatabaseQuery(2)(3);
        });
      });
      await work.time("preparation", async () => {
        beginDatabaseQuery(4)(5);
      });
      await work.time("model", async () => {});
      work.add({ timings: { externally_measured: 1 } });
    });
    expect(sample).toMatchObject({
      queries: 3,
      phaseQueries: { preparation: 3, discovery: 1, model: null },
    });
    expect(sample?.phaseQueries).not.toHaveProperty("externally_measured");
  });

  it("summarizes nested operation work once even when a request fails", async () => {
    const attributes: Record<string, string | number | boolean | undefined> =
      {};
    const span = {
      setAttributes: (values: typeof attributes) =>
        Object.assign(attributes, values),
    };
    const sentinel = new Error("request sentinel");
    await expect(
      withDatabaseRequestMetrics(span, async () => {
        beginDatabaseAcquire(0)(2);
        await withDatabaseOperationMetrics(async () => {
          beginDatabaseQuery(10)(15);
          await withDatabaseOperationMetrics(async () => {
            beginDatabaseQuery(20)(27);
          });
        });
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(attributes).toMatchObject({
      "db.query.count": 2,
      "db.query.duration_sum_ms": 12,
      "db.acquire.count": 1,
    });
  });

  it("reports quiescence only after every outstanding database operation settles", async () => {
    await withDatabaseOperationMetrics(async (metrics) => {
      expect(metrics.isIdle()).toBe(true);
      const query = beginDatabaseQuery();
      const acquire = beginDatabaseAcquire();
      expect(metrics.isIdle()).toBe(false);
      query();
      expect(metrics.isIdle()).toBe(false);
      acquire();
      expect(metrics.isIdle()).toBe(true);
    });
  });

  it("distinguishes summed work from overlapping active wall time", async () => {
    await withDatabaseOperationMetrics(async (metrics) => {
      const finishQueryA = beginDatabaseQuery(10);
      const finishQueryB = beginDatabaseQuery(12);
      finishQueryB(17);
      finishQueryA(20);

      const finishQueryC = beginDatabaseQuery(25);
      finishQueryC(28);

      const finishAcquireA = beginDatabaseAcquire(30);
      const finishAcquireB = beginDatabaseAcquire(31);
      finishAcquireA(34);
      finishAcquireB(36);

      expect(metrics).toMatchObject({
        queryCount: 3,
        queryDurationSumMs: 18,
        queryActiveWallMs: 13,
        queryMaxDurationMs: 10,
        queryMaxConcurrency: 2,
        // A and B overlap (one round trip); C starts after both settle.
        querySerialStarts: 2,
        acquireCount: 2,
        acquireDurationSumMs: 9,
        acquireActiveWallMs: 6,
        acquireMaxDurationMs: 5,
        acquireMaxConcurrency: 2,
      });
    });
  });

  it("ignores duplicate finishes and calls outside an operation", async () => {
    beginDatabaseQuery(0)(5);
    beginDatabaseAcquire(0)(5);

    await withDatabaseOperationMetrics(async (metrics) => {
      const finish = beginDatabaseQuery(10);
      finish(14);
      finish(40);

      expect(metrics.queryCount).toBe(1);
      expect(metrics.queryDurationSumMs).toBe(4);
      expect(metrics.queryActiveWallMs).toBe(4);
    });
  });

  it("records phase-local work without removing it from the operation total", async () => {
    await withDatabaseOperationMetrics(async (operation) => {
      beginDatabaseQuery(0)(3);
      await withDatabaseOperationMetrics(async (phase) => {
        beginDatabaseQuery(10)(17);
        expect(phase).toMatchObject({
          queryCount: 1,
          queryDurationSumMs: 7,
          queryActiveWallMs: 7,
        });
      });
      expect(operation).toMatchObject({
        queryCount: 2,
        queryDurationSumMs: 10,
        queryActiveWallMs: 10,
      });
    });
  });
});
