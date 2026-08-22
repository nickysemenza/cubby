import type {
  BackgroundBatchSummary,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchDetail } from "./batch-detail";

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

describe("BatchDetail", () => {
  it("requests server-side failed filtering and bounded next pages", () => {
    const onFailedOnlyChange = vi.fn();
    const onPageChange = vi.fn();

    render(
      <BatchDetail
        batch={batch}
        jobs={[job]}
        pageIndex={0}
        pageSize={100}
        totalCount={201}
        showFailedOnly={false}
        onFailedOnlyChange={onFailedOnlyChange}
        onPageChange={onPageChange}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onRetryJob={vi.fn()}
      />,
    );

    expect(screen.getByText("Jobs 1–100 of 201")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Failed only" }));
    expect(onFailedOnlyChange).toHaveBeenCalledWith(true);
  });
});
