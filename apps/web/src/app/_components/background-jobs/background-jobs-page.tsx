import type { BackgroundBatchStatus } from "@cubby/schemas/background-jobs";
import { getErrorMessage } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Eraser, StepForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useHydratedLoading } from "~/hooks/useHydrated";
import {
  backgroundBatch,
  backgroundJob,
} from "~/lib/background-batch.functions";

import {
  buildBackgroundJobRows,
  type SelectedJobsState,
} from "./background-job-rows";
import { BackgroundJobsTable } from "./background-jobs-table";

const BATCH_POLL_MS = 4000;
const JOB_PAGE_SIZE = 100;

function isBatchLive(status: BackgroundBatchStatus): boolean {
  return status === "queued" || status === "running";
}

export function didBatchSettle(
  previousStatus: BackgroundBatchStatus | undefined,
  currentStatus: BackgroundBatchStatus | undefined,
): boolean {
  return (
    previousStatus !== undefined &&
    currentStatus !== undefined &&
    isBatchLive(previousStatus) &&
    !isBatchLive(currentStatus)
  );
}

export function BackgroundJobsPage({
  selectedBatchId,
  scopedBatchIds,
}: {
  selectedBatchId?: string;
  scopedBatchIds?: string[];
}) {
  const navigate = useNavigate();
  const [pageIndex, setPageIndex] = useState(0);
  const [showFailedOnly, setShowFailedOnly] = useState(false);

  const scopedSet = useMemo(
    () => (scopedBatchIds?.length ? new Set(scopedBatchIds) : null),
    [scopedBatchIds],
  );

  const listQuery = useQuery({
    ...backgroundBatch.list.queryOptions({ limit: 25 }),
    refetchInterval: (query) => {
      const batches = query.state.data;
      if (!batches) return false;
      const relevant = scopedSet
        ? batches.filter((batch) => scopedSet.has(batch.id))
        : batches;
      return relevant.some((batch) => isBatchLive(batch.status))
        ? BATCH_POLL_MS
        : false;
    },
  });

  const selectedInput = { batchId: selectedBatchId ?? "" };
  const summaryQuery = useQuery({
    ...backgroundBatch.summary.queryOptions(selectedInput),
    enabled: Boolean(selectedBatchId),
    refetchInterval: (query) =>
      query.state.data && isBatchLive(query.state.data.status)
        ? BATCH_POLL_MS
        : false,
  });
  const jobsQuery = useQuery({
    ...backgroundBatch.jobs.queryOptions({
      batchId: selectedBatchId ?? "",
      pageIndex,
      pageSize: JOB_PAGE_SIZE,
      failedOnly: showFailedOnly,
    }),
    enabled: Boolean(selectedBatchId),
  });

  const previousStatusRef = useRef<BackgroundBatchStatus | undefined>(
    undefined,
  );
  const currentStatus = summaryQuery.data?.status;
  const refetchJobs = jobsQuery.refetch;
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = currentStatus;
    if (didBatchSettle(previousStatus, currentStatus)) void refetchJobs();
  }, [currentStatus, refetchJobs]);

  useEffect(() => {
    setPageIndex(0);
    previousStatusRef.current = undefined;
  }, [selectedBatchId]);

  // Every mutation on this page invalidates the `["background-batch"]` root,
  // which prefix-matches the list, summary, jobs and stranded-count tags — so
  // the only thing left to do on success is put the job pager back on page one.
  const resetPager = () => setPageIndex(0);
  const drain = useMutation(backgroundJob.drain.mutationOptions());
  const strandedQuery = useQuery(backgroundJob.strandedCount.queryOptions({}));
  const clearStranded = useMutation(
    backgroundJob.clearStranded.mutationOptions(),
  );
  const retry = useMutation({
    ...backgroundBatch.retry.mutationOptions(),
    onSuccess: resetPager,
  });
  const retryJob = useMutation({
    ...backgroundJob.retry.mutationOptions(),
    onSuccess: () => {
      if (selectedBatchId) resetPager();
    },
  });
  const cancel = useMutation({
    ...backgroundBatch.cancel.mutationOptions(),
    onSuccess: resetPager,
  });

  const visibleBatches = scopedSet
    ? (listQuery.data ?? []).filter(({ id }) => scopedSet.has(id))
    : (listQuery.data ?? []);
  usePageCount(visibleBatches.length);

  let selectedJobs: SelectedJobsState | undefined;
  if (selectedBatchId) {
    if (jobsQuery.error)
      selectedJobs = {
        status: "error",
        message: getErrorMessage(jobsQuery.error),
        retry: () => void jobsQuery.refetch(),
      };
    else if (!jobsQuery.data) selectedJobs = { status: "loading" };
    else
      selectedJobs = {
        status: "ready",
        jobs: jobsQuery.data.jobs,
        pageIndex: jobsQuery.data.pageIndex,
        pageSize: jobsQuery.data.pageSize,
        totalCount: jobsQuery.data.totalCount,
        failedOnly: showFailedOnly,
      };
  }

  const rows = buildBackgroundJobRows({
    batches: visibleBatches,
    selectedBatchId,
    selectedBatch: summaryQuery.data,
    selectedBatchError: summaryQuery.error
      ? getErrorMessage(summaryQuery.error)
      : undefined,
    selectedBatchRetry: () => void summaryQuery.refetch(),
    selectedJobs,
  });

  const listLoading = useHydratedLoading(listQuery.isLoading);
  const setExpandedBatch = (batchId?: string, failedOnly = false) => {
    setPageIndex(0);
    setShowFailedOnly(failedOnly);
    void navigate({
      to: "/background-jobs",
      search: (previous) => ({ ...previous, batchId }),
    });
  };

  // Only rendered when there is something to clear: an always-visible button
  // for a table that is normally empty reads as a routine step rather than the
  // exception it is.
  const abandonedCount = strandedQuery.data?.abandoned ?? 0;
  const drainAction = (
    <>
      {abandonedCount > 0 ? (
        <Button
          type="button"
          variant="outline"
          disabled={clearStranded.isPending}
          onClick={() => clearStranded.mutate({})}
        >
          {clearStranded.isPending ? (
            <Spinner className="size-3" />
          ) : (
            <Eraser />
          )}
          Clear {abandonedCount.toLocaleString()} stranded
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={drain.isPending}
        onClick={() => drain.mutate({ limit: 25 })}
      >
        {drain.isPending ? <Spinner className="size-3" /> : <StepForward />}
        Drain pending
      </Button>
    </>
  );

  return (
    <>
      {scopedSet ? (
        <Row align="center" gap="sm" className="text-sm text-muted-foreground">
          <span>
            Showing {scopedSet.size} background{" "}
            {scopedSet.size === 1 ? "batch" : "batches"} from your last action.
          </span>
          <Link
            to="/background-jobs"
            search={(previous) => ({ batchId: previous.batchId })}
            className="underline decoration-dotted underline-offset-2 hover:decoration-primary"
          >
            Clear
          </Link>
        </Row>
      ) : null}
      <BackgroundJobsTable
        rows={rows}
        selectedBatchId={selectedBatchId}
        showFailedOnly={showFailedOnly}
        isLoading={listLoading}
        error={listQuery.error}
        onRetry={() => void listQuery.refetch()}
        actions={drainAction}
        onExpandedBatchChange={setExpandedBatch}
        onFailedOnlyChange={(batchId, failedOnly) => {
          if (batchId !== selectedBatchId)
            setExpandedBatch(batchId, failedOnly);
          else {
            setPageIndex(0);
            setShowFailedOnly(failedOnly);
          }
        }}
        onPageChange={setPageIndex}
        onRetryBatch={(batchId) => retry.mutate({ batchId })}
        onCancelBatch={(batchId) => cancel.mutate({ batchId })}
        onRetryJob={(jobId) => retryJob.mutate({ jobId })}
      />
    </>
  );
}
