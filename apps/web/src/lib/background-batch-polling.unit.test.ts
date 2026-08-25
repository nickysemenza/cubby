import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { backgroundBatchSummaryQueryOptions } = vi.hoisted(() => ({
  backgroundBatchSummaryQueryOptions: vi.fn((input: { batchId: string }) => ({
    queryKey: [["background-batch", "summary"], input],
    queryFn: async () => ({ status: "running" as const }),
  })),
}));

vi.mock("~/lib/background-batch.functions", () => ({
  backgroundBatchSummaryQueryOptions,
}));

import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "./background-batch-polling";

const queuedResult = {
  sideEffects: {
    backgroundBatches: [
      {
        id: "batch-1",
        kind: "entity-embedding.refresh" as const,
        source: "mutation" as const,
        processor: "queue" as const,
        status: "queued" as const,
        totalJobs: 8_001,
      },
    ],
  },
};

describe("background batch polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fetches only the batch summary for status checks", async () => {
    const queryClient = new QueryClient();
    await expect(makeBatchStatusFetcher(queryClient)("batch-1")).resolves.toBe(
      "running",
    );
    expect(backgroundBatchSummaryQueryOptions).toHaveBeenCalledWith({
      batchId: "batch-1",
    });
  });

  it("stops at terminal status and invalidates once", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const fetchBatchStatus = vi
      .fn()
      .mockResolvedValueOnce("running")
      .mockResolvedValueOnce("succeeded");

    const watching = watchBatchesAndInvalidate({
      queryClient,
      result: queuedResult,
      invalidateKeys: [["product"]],
      fetchBatchStatus,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await watching;

    expect(fetchBatchStatus).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("retains the 30-attempt timeout before invalidating", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const fetchBatchStatus = vi.fn().mockResolvedValue("running");

    const watching = watchBatchesAndInvalidate({
      queryClient,
      result: queuedResult,
      invalidateKeys: [["product"]],
      fetchBatchStatus,
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await watching;

    expect(fetchBatchStatus).toHaveBeenCalledTimes(30);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
