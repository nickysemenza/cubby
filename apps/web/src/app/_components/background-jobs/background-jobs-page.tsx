import {
  type BackgroundBatchStatus,
  backgroundBatchProcessors,
  backgroundBatchSources,
  backgroundBatchStatuses,
  backgroundJobKinds,
} from "@cubby/schemas/background-jobs";
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
import { Row, Stack } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Spinner } from "~/components/ui/spinner";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import {
  buildBackgroundJobRows,
  type SelectedJobsState,
} from "./background-job-rows";
import { BackgroundJobsTable } from "./background-jobs-table";
import { batchFilterText } from "./batch-metadata";

const ALL_FILTER_VALUE = "all";
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
  const api = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState(ALL_FILTER_VALUE);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER_VALUE);
  const [processorFilter, setProcessorFilter] = useState(ALL_FILTER_VALUE);
  const [statusFilter, setStatusFilter] = useState(ALL_FILTER_VALUE);
  const [textFilter, setTextFilter] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [showFailedOnly, setShowFailedOnly] = useState(false);

  const scopedSet = useMemo(
    () => (scopedBatchIds?.length ? new Set(scopedBatchIds) : null),
    [scopedBatchIds],
  );

  const listQuery = useQuery({
    ...api.backgroundJobs.listBatches.queryOptions({ limit: 25 }),
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
    ...api.backgroundJobs.getBatchSummary.queryOptions(selectedInput),
    enabled: Boolean(selectedBatchId),
    refetchInterval: (query) =>
      query.state.data && isBatchLive(query.state.data.status)
        ? BATCH_POLL_MS
        : false,
  });
  const jobsInput = useMemo(
    () => ({
      batchId: selectedBatchId ?? "",
      pageIndex,
      pageSize: JOB_PAGE_SIZE,
      failedOnly: showFailedOnly,
    }),
    [pageIndex, selectedBatchId, showFailedOnly],
  );
  const jobsQuery = useQuery({
    ...api.backgroundJobs.listBatchJobs.queryOptions(jobsInput),
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
    setShowFailedOnly(false);
    previousStatusRef.current = undefined;
  }, [selectedBatchId]);

  const invalidateAfterMutation = (batchId: string) => {
    setPageIndex(0);
    invalidateTRPCQueries(queryClient, [
      api.backgroundJobs.listBatches.queryKey(),
      api.backgroundJobs.getBatchSummary.queryKey({ batchId }),
      api.backgroundJobs.listBatchJobs.queryKey(),
    ]);
  };
  const invalidateList = () => {
    const keys: QueryKey[] = [api.backgroundJobs.listBatches.queryKey()];
    invalidateTRPCQueries(queryClient, keys);
  };
  const drain = useMutation(
    api.backgroundJobs.drain.mutationOptions({ onSuccess: invalidateList }),
  );
  const retry = useMutation(
    api.backgroundJobs.retryBatch.mutationOptions({
      onSuccess: (_data, variables) =>
        invalidateAfterMutation(variables.batchId),
    }),
  );
  const retryJob = useMutation(
    api.backgroundJobs.retryJob.mutationOptions({
      onSuccess: () => {
        if (selectedBatchId) invalidateAfterMutation(selectedBatchId);
      },
    }),
  );
  const cancel = useMutation(
    api.backgroundJobs.cancelBatch.mutationOptions({
      onSuccess: (_data, variables) =>
        invalidateAfterMutation(variables.batchId),
    }),
  );

  const filteredBatches = useMemo(() => {
    const query = textFilter.trim().toLowerCase();
    return (listQuery.data ?? []).filter((batch) => {
      if (scopedSet && !scopedSet.has(batch.id)) return false;
      if (kindFilter !== ALL_FILTER_VALUE && batch.kind !== kindFilter) {
        return false;
      }
      if (sourceFilter !== ALL_FILTER_VALUE && batch.source !== sourceFilter) {
        return false;
      }
      if (
        processorFilter !== ALL_FILTER_VALUE &&
        batch.processor !== processorFilter
      ) {
        return false;
      }
      if (statusFilter !== ALL_FILTER_VALUE && batch.status !== statusFilter) {
        return false;
      }
      return query.length === 0 || batchFilterText(batch).includes(query);
    });
  }, [
    kindFilter,
    listQuery.data,
    processorFilter,
    scopedSet,
    sourceFilter,
    statusFilter,
    textFilter,
  ]);

  usePageCount(filteredBatches.length);

  const selectedJobs = useMemo<SelectedJobsState | undefined>(() => {
    if (!selectedBatchId) return undefined;
    if (jobsQuery.isLoading) return { status: "loading" };
    if (jobsQuery.error) {
      return { status: "error", message: getErrorMessage(jobsQuery.error) };
    }
    if (!jobsQuery.data) return { status: "loading" };
    return {
      status: "ready",
      jobs: jobsQuery.data.jobs,
      pageIndex: jobsQuery.data.pageIndex,
      pageSize: jobsQuery.data.pageSize,
      totalCount: jobsQuery.data.totalCount,
      failedOnly: showFailedOnly,
    };
  }, [
    jobsQuery.data,
    jobsQuery.error,
    jobsQuery.isLoading,
    selectedBatchId,
    showFailedOnly,
  ]);

  const rows = useMemo(
    () =>
      buildBackgroundJobRows({
        batches: filteredBatches,
        selectedBatchId,
        selectedBatch: summaryQuery.data,
        selectedBatchError: summaryQuery.error
          ? getErrorMessage(summaryQuery.error)
          : undefined,
        selectedJobs,
      }),
    [
      filteredBatches,
      selectedBatchId,
      selectedJobs,
      summaryQuery.data,
      summaryQuery.error,
    ],
  );

  const listLoading = useHydratedLoading(listQuery.isLoading);
  const filtersActive =
    textFilter.trim().length > 0 ||
    kindFilter !== ALL_FILTER_VALUE ||
    sourceFilter !== ALL_FILTER_VALUE ||
    processorFilter !== ALL_FILTER_VALUE ||
    statusFilter !== ALL_FILTER_VALUE ||
    scopedSet !== null;

  const setExpandedBatch = (batchId?: string) => {
    void navigate({
      to: "/background-jobs",
      search: (previous) => ({ ...previous, batchId }),
    });
  };

  const toolbar = (
    <Row gap="sm" wrap className="min-w-0">
      <Input
        value={textFilter}
        onChange={(event) => setTextFilter(event.target.value)}
        placeholder="Filter source, entity, or id"
        aria-label="Filter background jobs"
        className="w-64 max-w-full"
      />
      <NativeSelect
        aria-label="Filter background jobs by kind"
        value={kindFilter}
        onChange={(event) => setKindFilter(event.target.value)}
      >
        <option value={ALL_FILTER_VALUE}>All kinds</option>
        {backgroundJobKinds.map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Filter background jobs by source"
        value={sourceFilter}
        onChange={(event) => setSourceFilter(event.target.value)}
      >
        <option value={ALL_FILTER_VALUE}>All sources</option>
        {backgroundBatchSources.map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Filter background jobs by processor"
        value={processorFilter}
        onChange={(event) => setProcessorFilter(event.target.value)}
      >
        <option value={ALL_FILTER_VALUE}>All processors</option>
        {backgroundBatchProcessors.map((processor) => (
          <option key={processor} value={processor}>
            {processor}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Filter background jobs by status"
        value={statusFilter}
        onChange={(event) => setStatusFilter(event.target.value)}
      >
        <option value={ALL_FILTER_VALUE}>All statuses</option>
        {backgroundBatchStatuses.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </NativeSelect>
    </Row>
  );

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
    <Stack gap="sm">
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
        toolbar={toolbar}
        actions={drainAction}
        emptyState={
          filtersActive
            ? "No background batches match these filters."
            : "No background batches yet."
        }
        onExpandedBatchChange={setExpandedBatch}
        onFailedOnlyChange={(batchId, failedOnly) => {
          setPageIndex(0);
          setShowFailedOnly(failedOnly);
          if (batchId !== selectedBatchId) setExpandedBatch(batchId);
        }}
        onPageChange={setPageIndex}
        onRetryBatch={(batchId) => retry.mutate({ batchId })}
        onCancelBatch={(batchId) => cancel.mutate({ batchId })}
        onRetryJob={(jobId) => retryJob.mutate({ jobId })}
      />
    </Stack>
  );
}
