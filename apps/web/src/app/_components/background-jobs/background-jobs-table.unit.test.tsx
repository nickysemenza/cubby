import type {
  BackgroundBatchSummary,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { buildBackgroundJobRows } from "./background-job-rows";
import { BackgroundJobsTable } from "./background-jobs-table";

const batch: BackgroundBatchSummary = {
  id: "batch-1",
  kind: "location-valuation.recompute",
  source: "mutation",
  processor: "queue",
  status: "running",
  totalJobs: 1,
  queuedJobs: 0,
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
  kind: batch.kind,
  dedupeKey: "valuation",
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  queuedAt: batch.createdAt,
  startedAt: batch.updatedAt,
  finishedAt: null,
  durationMs: null,
  lastError: null,
  payload: { reason: "test" },
  createdAt: batch.createdAt,
  updatedAt: batch.updatedAt,
};

interface BackgroundJobsTableEvents {
  readonly onRetry: () => void;
  readonly onExpandedBatchChange: (batchId?: string) => void;
  readonly onFailedOnlyChange: (batchId: string, failedOnly: boolean) => void;
  readonly onRetryBatch: (batchId: string) => void;
  readonly onCancelBatch: (batchId: string) => void;
  readonly onRetryJob: (jobId: string) => void;
  readonly onPageChange: (pageIndex: number) => void;
  readonly retrySelectedSummary: () => void;
  readonly retryCount: () => number;
  readonly expandedBatchIds: () => Array<string | undefined>;
  readonly failedOnlyChanges: () => Array<{
    batchId: string;
    failedOnly: boolean;
  }>;
  readonly selectedSummaryRetryCount: () => number;
}

function createBackgroundJobsTableEvents(): BackgroundJobsTableEvents {
  let retries = 0;
  let selectedSummaryRetries = 0;
  const expandedBatchIds: Array<string | undefined> = [];
  const failedOnlyChanges: Array<{ batchId: string; failedOnly: boolean }> = [];

  return {
    onRetry: () => {
      retries += 1;
    },
    onExpandedBatchChange: (batchId) => {
      expandedBatchIds.push(batchId);
    },
    onFailedOnlyChange: (batchId, failedOnly) => {
      failedOnlyChanges.push({ batchId, failedOnly });
    },
    onRetryBatch: () => undefined,
    onCancelBatch: () => undefined,
    onRetryJob: () => undefined,
    onPageChange: () => undefined,
    retrySelectedSummary: () => {
      selectedSummaryRetries += 1;
    },
    retryCount: () => retries,
    expandedBatchIds: () => expandedBatchIds,
    failedOnlyChanges: () => failedOnlyChanges,
    selectedSummaryRetryCount: () => selectedSummaryRetries,
  };
}

interface RenderWorkbenchOptions {
  readonly selectedBatchId?: string;
  readonly batches?: BackgroundBatchSummary[];
  readonly error?: Error | null;
  readonly selectedBatchError?: string;
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(async () => {
  harness = createBrowserTestHarness();
  await act(async () => {
    await harness.loadRouter();
  });
});

afterEach(() => {
  harness.dispose();
});

function renderWorkbench(
  options: RenderWorkbenchOptions = {},
): BackgroundJobsTableEvents {
  const events = createBackgroundJobsTableEvents();
  const selectedBatchId = options.selectedBatchId;
  const rows = buildBackgroundJobRows({
    batches: options.batches ?? [batch],
    selectedBatchId,
    selectedBatchError: options.selectedBatchError,
    selectedBatchRetry: events.retrySelectedSummary,
    selectedJobs: selectedBatchId
      ? {
          status: "ready",
          jobs: [job],
          pageIndex: 0,
          pageSize: 100,
          totalCount: 1,
          failedOnly: false,
        }
      : undefined,
  });
  render(
    <BackgroundJobsTable
      rows={rows}
      selectedBatchId={selectedBatchId}
      showFailedOnly={false}
      isLoading={false}
      error={options.error ?? null}
      onRetry={events.onRetry}
      actions={<button type="button">Drain pending</button>}
      onExpandedBatchChange={events.onExpandedBatchChange}
      onFailedOnlyChange={events.onFailedOnlyChange}
      onRetryBatch={events.onRetryBatch}
      onCancelBatch={events.onCancelBatch}
      onRetryJob={events.onRetryJob}
      onPageChange={events.onPageChange}
    />,
    { wrapper: harness.routerWrapper },
  );
  return events;
}

describe("BackgroundJobsTable", () => {
  it("uses the standard workbench and exposes the selected jobs as subrows", async () => {
    renderWorkbench({ selectedBatchId: batch.id });

    expect(
      await screen.findByRole("table", { name: "Background jobs" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Drain pending" })).toBeVisible();
    expect(screen.getByText("batch-1")).toBeVisible();
    expect(screen.getByText("job-1")).toBeVisible();
  });

  it("maps disclosure changes back to the singular batch id", async () => {
    const events = renderWorkbench();

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand batch" }),
    );

    expect(events.expandedBatchIds()).toEqual(["batch-1"]);
  });

  it("clears the singular batch id when the selected row collapses", async () => {
    const events = renderWorkbench({ selectedBatchId: batch.id });

    fireEvent.click(
      await screen.findByRole("button", { name: "Collapse batch" }),
    );

    expect(events.expandedBatchIds()).toEqual([undefined]);
  });

  it("sorts created dates chronologically rather than by their display text", async () => {
    const january = {
      ...batch,
      id: "january",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const june = {
      ...batch,
      id: "june",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    };

    renderWorkbench({ batches: [january, june] });

    const records = (await screen.findAllByText(/^(january|june)$/)).map(
      (element) => element.textContent,
    );
    expect(records).toEqual(["june", "january"]);
  });

  it("carries failed-only intent when its batch is not selected yet", async () => {
    const events = renderWorkbench();

    fireEvent.click(await screen.findByRole("button", { name: "Open menu" }));
    fireEvent.click(await screen.findByText("Show failed jobs"));

    expect(events.failedOnlyChanges()).toEqual([
      { batchId: "batch-1", failedOnly: true },
    ]);
  });

  it("keeps cached rows recoverable when the list query errors", async () => {
    const events = renderWorkbench({ error: new Error("Queue unavailable") });

    expect(await screen.findByRole("alert")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry background jobs" }),
    );
    expect(events.retryCount()).toBe(1);
  });

  it("renders a retry action for a recent selected-summary error", async () => {
    const events = renderWorkbench({
      selectedBatchId: batch.id,
      selectedBatchError: "Summary unavailable",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(events.selectedSummaryRetryCount()).toBe(1);
  });
});
