import type {
  BackgroundBatchSummary,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";

interface BackgroundBatchRow {
  rowType: "batch";
  rowKey: `batch:${string}`;
  id: string;
  name: string;
  batch: BackgroundBatchSummary;
  selectedOutsideList: boolean;
  subRows?: BackgroundJobTableRow[];
}

interface BackgroundJobRow {
  rowType: "job";
  rowKey: `job:${string}`;
  id: string;
  name: string;
  job: BackgroundJobSummary;
}

interface BackgroundStatusRow {
  rowType: "status";
  rowKey: `status:${string}:${"loading" | "error" | "empty"}`;
  id: string;
  name: string;
  batchId: string;
  status: "loading" | "error" | "empty";
  message: string;
}

interface BackgroundPagerRow {
  rowType: "pager";
  rowKey: `pager:${string}:${number}:${number}`;
  id: string;
  name: string;
  batchId: string;
  pageIndex: number;
  pageSize: number;
  totalCount: number;
}

type BackgroundJobTableRow =
  | BackgroundBatchRow
  | BackgroundJobRow
  | BackgroundStatusRow
  | BackgroundPagerRow;

type SelectedJobsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      jobs: BackgroundJobSummary[];
      pageIndex: number;
      pageSize: number;
      totalCount: number;
      failedOnly: boolean;
    };

interface BuildBackgroundJobRowsInput {
  batches: BackgroundBatchSummary[];
  selectedBatchId?: string;
  selectedBatch?: BackgroundBatchSummary;
  selectedBatchError?: string;
  selectedJobs?: SelectedJobsState;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function buildSelectedChildren(
  batchId: string,
  state: SelectedJobsState | undefined,
): BackgroundJobTableRow[] {
  if (!state || state.status === "loading") {
    return [
      {
        rowType: "status",
        rowKey: `status:${batchId}:loading`,
        id: batchId,
        name: "Loading jobs",
        batchId,
        status: "loading",
        message: "Loading jobs…",
      },
    ];
  }

  if (state.status === "error") {
    return [
      {
        rowType: "status",
        rowKey: `status:${batchId}:error`,
        id: batchId,
        name: "Jobs unavailable",
        batchId,
        status: "error",
        message: state.message,
      },
    ];
  }

  const rows: BackgroundJobTableRow[] = state.jobs.map((job) => ({
    rowType: "job",
    rowKey: `job:${job.id}`,
    id: job.id,
    name: `Job ${shortId(job.id)}`,
    job,
  }));

  if (rows.length === 0) {
    rows.push({
      rowType: "status",
      rowKey: `status:${batchId}:empty`,
      id: batchId,
      name: state.failedOnly ? "No failed jobs" : "No jobs",
      batchId,
      status: "empty",
      message: state.failedOnly ? "No failed jobs" : "No jobs",
    });
  }

  if (state.totalCount > state.pageSize) {
    const firstJob =
      state.totalCount === 0 ? 0 : state.pageIndex * state.pageSize + 1;
    const lastJob = Math.min(
      (state.pageIndex + 1) * state.pageSize,
      state.totalCount,
    );
    const label = `Jobs ${firstJob}–${lastJob} of ${state.totalCount}`;
    rows.push({
      rowType: "pager",
      rowKey: `pager:${batchId}:${state.pageIndex}:${state.totalCount}`,
      id: batchId,
      name: label,
      batchId,
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
  selectedJobs,
}: BuildBackgroundJobRowsInput): BackgroundJobTableRow[] {
  const visible = [...batches];
  const visibleIds = new Set(visible.map((batch) => batch.id));
  if (selectedBatch && !visibleIds.has(selectedBatch.id)) {
    visible.unshift(selectedBatch);
  }

  const rows: BackgroundJobTableRow[] = visible.map((batch) => {
    const selected = batch.id === selectedBatchId;
    const liveBatch = selected && selectedBatch ? selectedBatch : batch;
    return {
      rowType: "batch",
      rowKey: `batch:${liveBatch.id}`,
      id: liveBatch.id,
      name: `Batch ${shortId(liveBatch.id)}`,
      batch: liveBatch,
      selectedOutsideList:
        selected && selectedBatch != null && !visibleIds.has(selectedBatch.id),
      ...(selected
        ? { subRows: buildSelectedChildren(liveBatch.id, selectedJobs) }
        : {}),
    };
  });

  if (
    selectedBatchId &&
    !rows.some(
      (row) => row.rowType === "batch" && row.batch.id === selectedBatchId,
    ) &&
    selectedBatchError
  ) {
    rows.unshift({
      rowType: "status",
      rowKey: `status:${selectedBatchId}:error`,
      id: selectedBatchId,
      name: "Batch unavailable",
      batchId: selectedBatchId,
      status: "error",
      message: selectedBatchError,
    });
  }

  return rows;
}

function backgroundJobRowId(row: BackgroundJobTableRow): string {
  return row.rowKey;
}

function backgroundJobSubRows(
  row: BackgroundJobTableRow,
): BackgroundJobTableRow[] | undefined {
  return row.rowType === "batch" ? row.subRows : undefined;
}

export {
  type BackgroundBatchRow,
  type BackgroundJobRow,
  type BackgroundJobTableRow,
  backgroundJobRowId,
  backgroundJobSubRows,
  buildBackgroundJobRows,
  type SelectedJobsState,
};
