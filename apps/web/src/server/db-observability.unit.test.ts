import { describe, expect, it } from "vitest";
import {
  recordDatabaseAcquire,
  recordDatabaseQuery,
  withDatabaseOperationMetrics,
} from "./db-observability";

describe("database operation metrics", () => {
  it("totals query/acquire time and retains the slowest query", async () => {
    await withDatabaseOperationMetrics(async (metrics) => {
      recordDatabaseQuery(3.5);
      recordDatabaseQuery(8.5);
      recordDatabaseAcquire(2.25);

      expect(metrics).toMatchObject({
        queryCount: 2,
        queryDurationMs: 12,
        queryMaxDurationMs: 8.5,
        acquireCount: 1,
        acquireDurationMs: 2.25,
      });
    });
  });
});
