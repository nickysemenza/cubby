import type { BackgroundBatchStatus } from "@cubby/schemas/background-jobs";
import { getErrorMessage } from "@cubby/shared";
import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { StepForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useHydratedLoading } from "~/hooks/useHydrated";
import {
  backgroundBatchCancelMutationOptions,
  backgroundBatchJobsQueryOptions,
  backgroundBatchJobsRootKey,
  backgroundBatchListQueryOptions,
  backgroundBatchListRootKey,
  backgroundBatchRetryMutationOptions,
  backgroundBatchSummaryQueryOptions,
  backgroundBatchSummaryRootKey,
  backgroundJobRetryMutationOptions,
  backgroundJobsDrainMutationOptions,
} from "~/lib/background-batch.functions";
import { invalidateQueryRoots } from "~/lib/query-keys";
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
  const queryClient = useQueryClient();
  const [pageIndex, setPageIndex] = useState(0);
  const [showFailedOnly, setShowFailedOnly] = useState(false);

  const scopedSet = useMemo(
    () => (scopedBatchIds?.length ? new Set(scopedBatchIds) : null),
    [scopedBatchIds],
  );

  const listQuery = useQuery({
    ...backgroundBatchListQueryOptions({ limit: 25 }),
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
    ...backgroundBatchSummaryQueryOptions(selectedInput),
    enabled: Boolean(selectedBatchId),
    refetchInterval: (query) =>
      query.state.data && isBatchLive(query.state.data.status)
        ? BATCH_POLL_MS
        : false,
  });
  const jobsQuery = useQuery({
    ...backgroundBatchJobsQueryOptions({
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected id is the reset signal; the effect deliberately resets local child-query controls without reading the id.
  useEffect(() => {
    setPageIndex(0);
    previousStatusRef.current = undefined;
  }, [selectedBatchId]);

  const invalidateAfterMutation = () => {
    setPageIndex(0);
    invalidateQueryRoots(queryClient, [
      backgroundBatchListRootKey(),
      backgroundBatchSummaryRootKey(),
      backgroundBatchJobsRootKey(),
    ]);
  };
  const invalidateList = () => {
    const keys: QueryKey[] = [backgroundBatchListRootKey()];
    invalidateQueryRoots(queryClient, keys);
  };
  const drain = useMutation({
    ...backgroundJobsDrainMutationOptions(),
    onSuccess: invalidateList,
  });
  const retry = useMutation({
    ...backgroundBatchRetryMutationOptions(),
    onSuccess: () => invalidateAfterMutation(),
  });
  const retryJob = useMutation({
    ...backgroundJobRetryMutationOptions(),
    onSuccess: () => {
      if (selectedBatchId) invalidateAfterMutation();
    },
  });
  const cancel = useMutation({
    ...backgroundBatchCancelMutationOptions(),
    onSuccess: () => invalidateAfterMutation(),
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

  const drainAction = (
    <Button
      type="button"
      variant="outline"
      disabled={drain.isPending}
      onClick={() => drain.mutate({ limit: 25 })}
    >
      {drain.isPending ? <Spinner className="size-3" /> : <StepForward />}
      Drain pending
    </Button>
  );

  return (
    <>
      {scopedSet ? (
        <Row align="center" gap="sm" className="text-muted-foreground text-sm">
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
