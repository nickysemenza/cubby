import { describe, expect, it } from "vitest";
import {
  beginDatabaseAcquire,
  beginDatabaseQuery,
  withDatabaseOperationMetrics,
} from "./db-observability";

describe("database operation metrics", () => {
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
        queryDurationMs: 18,
        queryDurationSumMs: 18,
        queryActiveWallMs: 13,
        queryMaxDurationMs: 10,
        queryMaxConcurrency: 2,
        acquireCount: 2,
        acquireDurationMs: 9,
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
