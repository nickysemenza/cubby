import type {
  BackgroundBatchStatus,
  BackgroundBatchSummary,
  BackgroundJobStatus,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";

import { formatMs } from "./format";

interface RowView {
  work?: string;
  route?: string;
  status?: BackgroundBatchStatus | BackgroundJobStatus;
  progress?: string;
  timing?: string;
  createdAt?: Date;
}

type RowBase = RowView & { id: string; name: string; rowKey: string };
type BackgroundBatchRow = RowBase & {
  rowType: "batch";
  rowKey: `batch:${string}`;
  batch: BackgroundBatchSummary;
  subRows?: BackgroundJobTableRow[];
};
type BackgroundJobRow = RowBase & {
  rowType: "job";
  rowKey: `job:${string}`;
  job: BackgroundJobSummary;
};
type BackgroundStatusRow = RowBase & {
  rowType: "status";
  rowKey: `status:${string}:${"loading" | "error" | "empty"}`;
  loadState: "loading" | "error" | "empty";
  retry?: () => void;
};
type BackgroundPagerRow = RowBase & {
  rowType: "pager";
  rowKey: `pager:${string}:${number}:${number}`;
  pageIndex: number;
  pageSize: number;
  totalCount: number;
};
type BackgroundJobTableRow =
  | BackgroundBatchRow
  | BackgroundJobRow
  | BackgroundStatusRow
  | BackgroundPagerRow;

type SelectedJobsState =
  | { status: "loading" }
  | { status: "error"; message: string; retry?: () => void }
  | {
      status: "ready";
      jobs: BackgroundJobSummary[];
      pageIndex: number;
      pageSize: number;
      totalCount: number;
      failedOnly: boolean;
    };

interface BuildRowsInput {
  batches: BackgroundBatchSummary[];
  selectedBatchId?: string;
  selectedBatch?: BackgroundBatchSummary;
  selectedBatchError?: string;
  selectedBatchRetry?: () => void;
  selectedJobs?: SelectedJobsState;
}

const shortId = (id: string) => id.slice(0, 8);
const statusRow = (
  batchId: string,
  loadState: BackgroundStatusRow["loadState"],
  message: string,
): BackgroundStatusRow => ({
  rowType: "status",
  rowKey: `status:${batchId}:${loadState}`,
  id: batchId,
  name: message,
  loadState,
});

function jobTiming(job: BackgroundJobSummary) {
  const wait =
    job.queuedAt && job.startedAt
      ? formatMs(Math.max(0, job.startedAt.getTime() - job.queuedAt.getTime()))
      : "";
  return `${formatMs(job.durationMs) || "—"}${wait ? ` · ${wait} wait` : ""}`;
}

function children(batchId: string, state?: SelectedJobsState) {
  if (!state || state.status === "loading")
    return [statusRow(batchId, "loading", "Loading jobs…")];
  if (state.status === "error")
    return [
      { ...statusRow(batchId, "error", state.message), retry: state.retry },
    ];

  const rows: BackgroundJobTableRow[] = state.jobs.map((job) => ({
    rowType: "job",
    rowKey: `job:${job.id}`,
    id: job.id,
    name: `Job ${shortId(job.id)}`,
    job,
    work: job.kind,
    route: job.dedupeKey,
    status: job.status,
    progress: `${job.attempts}/${job.maxAttempts}`,
    timing: jobTiming(job),
    createdAt: job.createdAt,
  }));
  if (rows.length === 0) {
    const message = state.failedOnly ? "No failed jobs" : "No jobs";
    rows.push(statusRow(batchId, "empty", message));
  }
  if (state.totalCount > state.pageSize) {
    const last = Math.min(
      (state.pageIndex + 1) * state.pageSize,
      state.totalCount,
    );
    rows.push({
      rowType: "pager",
      rowKey: `pager:${batchId}:${state.pageIndex}:${state.totalCount}`,
      id: batchId,
      name: `Jobs ${state.pageIndex * state.pageSize + 1}–${last} of ${state.totalCount}`,
      pageIndex: state.pageIndex,
      pageSize: state.pageSize,
      totalCount: state.totalCount,
    });
  }
  return rows;
}

function buildBackgroundJobRows({
  batches,
  selectedBatchId,
  selectedBatch,
  selectedBatchError,
  selectedBatchRetry,
  selectedJobs,
}: BuildRowsInput): BackgroundJobTableRow[] {
  const recentIds = new Set(batches.map(({ id }) => id));
  const visible =
    selectedBatch && !recentIds.has(selectedBatch.id)
      ? [selectedBatch, ...batches]
      : batches;
  const rows: BackgroundJobTableRow[] = visible.map((listedBatch) => {
    const selected = listedBatch.id === selectedBatchId;
    const batch = selected && selectedBatch ? selectedBatch : listedBatch;
    const completed = batch.succeededJobs + batch.skippedJobs;
    const row: BackgroundBatchRow = {
      rowType: "batch",
      rowKey: `batch:${batch.id}`,
      id: batch.id,
      name: `Batch ${shortId(batch.id)}`,
      batch,
      work: batch.kind,
      route: `${batch.processor} ${batch.source}`,
      status: batch.status,
      progress: `${completed}/${batch.totalJobs}${batch.failedJobs ? ` · ${batch.failedJobs} failed` : ""}`,
      timing: `${formatMs(batch.wallDurationMs) || "—"} · ${formatMs(batch.activeDurationMs)} active`,
      createdAt: batch.createdAt,
    };
    if (selected) {
      row.subRows = selectedBatchError
        ? [
            {
              ...statusRow(batch.id, "error", selectedBatchError),
              retry: selectedBatchRetry,
            },
          ]
        : children(batch.id, selectedJobs);
    }
    return row;
  });
  if (selectedBatchId && selectedBatchError && !recentIds.has(selectedBatchId))
    rows.unshift({
      ...statusRow(selectedBatchId, "error", selectedBatchError),
      retry: selectedBatchRetry,
    });
  return rows;
}

const backgroundJobRowId = (row: BackgroundJobTableRow) => row.rowKey;
const backgroundJobSubRows = (row: BackgroundJobTableRow) =>
  row.rowType === "batch" ? row.subRows : undefined;

export {
  type BackgroundBatchRow,
  type BackgroundJobRow,
  type BackgroundJobTableRow,
  backgroundJobRowId,
  backgroundJobSubRows,
  buildBackgroundJobRows,
  type SelectedJobsState,
};
