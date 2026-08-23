import type {
  BackgroundBatchSummary,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";
import { describe, expect, it } from "vitest";
import {
  backgroundJobSubRows,
  buildBackgroundJobRows,
  type SelectedJobsState,
} from "./background-job-rows";

const batch: BackgroundBatchSummary = {
  id: "batch-1",
  kind: "location-valuation.recompute",
  source: "mutation",
  processor: "queue",
  status: "running",
  totalJobs: 201,
  queuedJobs: 200,
  runningJobs: 1,
  succeededJobs: 0,
  failedJobs: 0,
  skippedJobs: 0,
  cancelledJobs: 0,
  firstEnqueuedAt: new Date("2026-08-22T12:00:00.000Z"),
  lastEnqueuedAt: new Date("2026-08-22T12:00:00.000Z"),
  firstJobStartedAt: new Date("2026-08-22T12:00:01.000Z"),
  lastJobFinishedAt: null,
  processingDurationMs: null,
  wallDurationMs: null,
  activeDurationMs: 1_000,
  metadata: null,
  createdAt: new Date("2026-08-22T12:00:00.000Z"),
  updatedAt: new Date("2026-08-22T12:00:01.000Z"),
};

const job: BackgroundJobSummary = {
  id: "job-1",
  batchId: batch.id,
  kind: "location-valuation.recompute",
  dedupeKey: "valuation",
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  queuedAt: new Date("2026-08-22T12:00:00.000Z"),
  startedAt: new Date("2026-08-22T12:00:01.000Z"),
  finishedAt: null,
  durationMs: null,
  lastError: null,
  payload: { reason: "test" },
  createdAt: new Date("2026-08-22T12:00:00.000Z"),
  updatedAt: new Date("2026-08-22T12:00:01.000Z"),
};

describe("background job table rows", () => {
  it("nests jobs under only the selected batch and appends bounded paging", () => {
    const [row] = buildBackgroundJobRows({
      batches: [batch],
      selectedBatchId: batch.id,
      selectedBatch: { ...batch, status: "succeeded" },
      selectedJobs: {
        status: "ready",
        jobs: [job],
        pageIndex: 0,
        pageSize: 100,
        totalCount: 201,
        failedOnly: false,
      },
    });

    expect(row).toMatchObject({
      rowType: "batch",
      rowKey: "batch:batch-1",
      id: "batch-1",
      batch: { status: "succeeded" },
    });
    expect(backgroundJobSubRows(row!)).toEqual([
      expect.objectContaining({
        rowType: "job",
        rowKey: "job:job-1",
        id: "job-1",
        job: expect.objectContaining({ id: "job-1" }),
      }),
      expect.objectContaining({
        rowType: "pager",
        name: "Jobs 1–100 of 201",
        pageIndex: 0,
      }),
    ]);
  });

  it.each<[SelectedJobsState, string, string]>([
    [{ status: "loading" } as const, "loading", "Loading jobs…"],
    [
      { status: "error", message: "Queue unavailable" } as const,
      "error",
      "Queue unavailable",
    ],
    [
      {
        status: "ready",
        jobs: [] as BackgroundJobSummary[],
        pageIndex: 0,
        pageSize: 100,
        totalCount: 0,
        failedOnly: true,
      },
      "empty",
      "No failed jobs",
    ],
  ])(
    "represents %s child state as a fixed row",
    (selectedJobs, status, message) => {
      const [row] = buildBackgroundJobRows({
        batches: [batch],
        selectedBatchId: batch.id,
        selectedJobs,
      });

      expect(backgroundJobSubRows(row!)).toEqual([
        expect.objectContaining({
          rowType: "status",
          loadState: status,
          name: message,
        }),
      ]);
    },
  );

  it("pins a deep-linked batch outside the recent filtered rows", () => {
    const selectedBatch = { ...batch, id: "older-batch" };
    const [selected, recent] = buildBackgroundJobRows({
      batches: [batch],
      selectedBatchId: selectedBatch.id,
      selectedBatch,
      selectedJobs: { status: "loading" },
    });

    expect(selected).toMatchObject({
      rowType: "batch",
      id: "older-batch",
    });
    expect(recent).toMatchObject({
      rowType: "batch",
      id: "batch-1",
    });
  });

  it("keeps unselected batches as leaves in the materialized row data", () => {
    const [row] = buildBackgroundJobRows({ batches: [batch] });

    expect(row).toMatchObject({ rowType: "batch", id: "batch-1" });
    expect(backgroundJobSubRows(row!)).toBeUndefined();
  });
});
