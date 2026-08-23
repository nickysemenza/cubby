import type {
  BackgroundBatchSummary,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";
import { flexRender } from "@tanstack/react-table";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CubbyTable } from "~/app/_components/data-table/table-features";
import type { BackgroundJobTableRow } from "./background-job-rows";
import { buildBackgroundJobRows } from "./background-job-rows";
import { BackgroundJobsTable } from "./background-jobs-table";

const { renderTable } = vi.hoisted(() => ({
  renderTable: vi.fn(
    (props: {
      additionalToolbarContent?: ReactNode;
      actions?: ReactNode;
      emptyState?: ReactNode;
    }) => (
      <div data-testid="standard-workbench">
        {props.additionalToolbarContent}
        {props.actions}
        {props.emptyState}
      </div>
    ),
  ),
}));

vi.mock("~/app/_components/data-table/Table", () => ({
  default: renderTable,
}));

vi.mock("~/app/_components/data-table/useTableState", () => ({
  useTableState: () => ({
    sorting: [{ id: "createdAt", desc: true }],
    setSorting: vi.fn(),
    columnFilters: [],
    allFilters: [],
    setColumnFilters: vi.fn(),
    pagination: { pageIndex: 0, pageSize: 25 },
    setPagination: vi.fn(),
  }),
}));

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

function renderWorkbench(
  selectedBatchId?: string,
  batches: BackgroundBatchSummary[] = [batch],
) {
  const rows = buildBackgroundJobRows({
    batches,
    selectedBatchId,
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
  const onExpandedBatchChange = vi.fn();
  const onFailedOnlyChange = vi.fn();
  render(
    <BackgroundJobsTable
      rows={rows}
      selectedBatchId={selectedBatchId}
      showFailedOnly={false}
      isLoading={false}
      error={null}
      actions={<button type="button">Drain pending</button>}
      onExpandedBatchChange={onExpandedBatchChange}
      onFailedOnlyChange={onFailedOnlyChange}
      onRetryBatch={vi.fn()}
      onCancelBatch={vi.fn()}
      onRetryJob={vi.fn()}
      onPageChange={vi.fn()}
    />,
  );
  const props = renderTable.mock.lastCall?.[0] as {
    table: CubbyTable<BackgroundJobTableRow>;
    ariaLabel: string;
    verticalAlign: string;
  };
  return { ...props, onExpandedBatchChange, onFailedOnlyChange };
}

describe("BackgroundJobsTable", () => {
  it("uses the standard workbench and exposes the selected jobs as subrows", () => {
    const { table, ariaLabel, verticalAlign } = renderWorkbench(batch.id);

    expect(screen.getByTestId("standard-workbench")).toBeVisible();
    expect(screen.getByRole("button", { name: "Drain pending" })).toBeVisible();
    expect(ariaLabel).toBe("Background jobs");
    expect(verticalAlign).toBe("top");
    expect(table.getRowModel().rows.map((row) => row.id)).toEqual([
      "batch:batch-1",
      "job:job-1",
    ]);
    expect(table.getRow("batch:batch-1").getCanExpand()).toBe(true);
    expect(table.getRow("job:job-1").getCanExpand()).toBe(false);
  });

  it("maps disclosure changes back to the singular batch id", () => {
    const { table, onExpandedBatchChange } = renderWorkbench();

    act(() => table.getRow("batch:batch-1").toggleExpanded(true));

    expect(onExpandedBatchChange).toHaveBeenCalledWith("batch-1");
  });

  it("clears the singular batch id when the selected row collapses", () => {
    const { table, onExpandedBatchChange } = renderWorkbench(batch.id);

    act(() => table.getRow("batch:batch-1").toggleExpanded(false));

    expect(onExpandedBatchChange).toHaveBeenCalledWith(undefined);
  });

  it("sorts created dates chronologically rather than by their display text", () => {
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

    const { table } = renderWorkbench(undefined, [january, june]);

    expect(table.getRowModel().rows.map((row) => row.id)).toEqual([
      "batch:june",
      "batch:january",
    ]);
  });

  it("carries failed-only intent when its batch is not selected yet", () => {
    const { table, onFailedOnlyChange } = renderWorkbench();
    const cell = table
      .getRow("batch:batch-1")
      .getAllCells()
      .find(({ column }) => column.id === "actions");
    if (!cell) throw new Error("Missing actions cell");
    render(flexRender(cell.column.columnDef.cell, cell.getContext()));

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByText("Show failed jobs"));

    expect(onFailedOnlyChange).toHaveBeenCalledWith("batch-1", true);
  });
});
