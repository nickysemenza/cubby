import {
  type BackgroundBatchStatus,
  backgroundBatchProcessors,
  backgroundBatchSources,
  backgroundBatchStatuses,
  backgroundJobKinds,
} from "@cubby/schemas/background-jobs";
import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { StepForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Spinner } from "~/components/ui/spinner";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { BatchDetail } from "./batch-detail";
import { batchFilterText } from "./batch-metadata";
import { BatchTable } from "./batch-table";

const ALL_FILTER_VALUE = "all";

// Poll cadence while a batch is still working. Fast enough that a batch you
// followed from a toast link visibly progresses; slow enough not to hammer the
// queue tables.
const BATCH_POLL_MS = 4000;
const JOB_PAGE_SIZE = 100;

// A batch is "live" (worth polling) until it reaches a terminal state. queued and
// running are in-flight; succeeded/partial/failed/cancelled are settled.
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

function SelectedBatchDetail({ batchId }: { batchId: string }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [pageIndex, setPageIndex] = useState(0);
  const [showFailedOnly, setShowFailedOnly] = useState(false);
  const jobsInput = useMemo(
    () => ({
      batchId,
      pageIndex,
      pageSize: JOB_PAGE_SIZE,
      failedOnly: showFailedOnly,
    }),
    [batchId, pageIndex, showFailedOnly],
  );
  const summaryQuery = useQuery({
    ...api.backgroundJobs.getBatchSummary.queryOptions({ batchId }),
    refetchInterval: (query) =>
      query.state.data && isBatchLive(query.state.data.status)
        ? BATCH_POLL_MS
        : false,
  });
  const jobsQuery = useQuery(
    api.backgroundJobs.listBatchJobs.queryOptions(jobsInput),
  );
  const previousStatusRef = useRef<BackgroundBatchStatus | undefined>(
    undefined,
  );
  const currentStatus = summaryQuery.data?.status;
  const refetchJobs = jobsQuery.refetch;

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = currentStatus;
    if (didBatchSettle(previousStatus, currentStatus)) {
      void refetchJobs();
    }
  }, [currentStatus, refetchJobs]);

  const invalidateAfterMutation = () => {
    setPageIndex(0);
    invalidateTRPCQueries(queryClient, [
      api.backgroundJobs.listBatches.queryKey(),
      api.backgroundJobs.getBatchSummary.queryKey({ batchId }),
      api.backgroundJobs.listBatchJobs.queryKey(),
    ]);
  };
  const retry = useMutation(
    api.backgroundJobs.retryBatch.mutationOptions({
      onSuccess: invalidateAfterMutation,
    }),
  );
  const retryJob = useMutation(
    api.backgroundJobs.retryJob.mutationOptions({
      onSuccess: invalidateAfterMutation,
    }),
  );
  const cancel = useMutation(
    api.backgroundJobs.cancelBatch.mutationOptions({
      onSuccess: invalidateAfterMutation,
    }),
  );
  const summaryLoading = useHydratedLoading(summaryQuery.isLoading);
  const jobsLoading = useHydratedLoading(jobsQuery.isLoading);

  if (summaryLoading || jobsLoading) return <Spinner />;
  if (!summaryQuery.data || !jobsQuery.data) return null;

  return (
    <BatchDetail
      batch={summaryQuery.data}
      jobs={jobsQuery.data.jobs}
      pageIndex={jobsQuery.data.pageIndex}
      pageSize={jobsQuery.data.pageSize}
      totalCount={jobsQuery.data.totalCount}
      showFailedOnly={showFailedOnly}
      onFailedOnlyChange={(failedOnly) => {
        setPageIndex(0);
        setShowFailedOnly(failedOnly);
      }}
      onPageChange={setPageIndex}
      onRetry={() => retry.mutate({ batchId })}
      onCancel={() => cancel.mutate({ batchId })}
      onRetryJob={(jobId) => retryJob.mutate({ jobId })}
    />
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
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState(ALL_FILTER_VALUE);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER_VALUE);
  const [processorFilter, setProcessorFilter] = useState(ALL_FILTER_VALUE);
  const [statusFilter, setStatusFilter] = useState(ALL_FILTER_VALUE);
  const [textFilter, setTextFilter] = useState("");
  // Poll while there's live work, then stop. You land here from a toast
  // `?batchId=` link the instant a batch is enqueued, so without this the status
  // is frozen at page-load until a manual reload. "Live" = queued or running; once
  // every relevant batch settles (succeeded/partial/failed/cancelled) polling
  // turns off (returns false) so a quiet queue isn't refetched forever.
  const listQuery = useQuery({
    ...api.backgroundJobs.listBatches.queryOptions({ limit: 25 }),
    refetchInterval: (query) => {
      const batches = query.state.data;
      if (!batches) return false;
      // Scope the "is anything live?" check to the batches this view cares about
      // (the scoped set from the action toast, else all) so an unrelated
      // long-running batch elsewhere doesn't keep this poll hot.
      const relevant = scopedBatchIds?.length
        ? batches.filter((b) => scopedBatchIds.includes(b.id))
        : batches;
      return relevant.some((b) => isBatchLive(b.status))
        ? BATCH_POLL_MS
        : false;
    },
  });
  // Hydration-stable loading gates — see the render below and useHydratedLoading.
  const listLoading = useHydratedLoading(listQuery.isLoading);

  const invalidateList = () => {
    const keys: QueryKey[] = [api.backgroundJobs.listBatches.queryKey()];
    invalidateTRPCQueries(queryClient, keys);
  };
  const drain = useMutation(
    api.backgroundJobs.drain.mutationOptions({ onSuccess: invalidateList }),
  );
  // Set by the save toast (?batchIds=…) to scope the list to one mutation's
  // batches. null ⇒ unscoped (show everything).
  const scopedSet = useMemo(
    () => (scopedBatchIds?.length ? new Set(scopedBatchIds) : null),
    [scopedBatchIds],
  );
  const filteredBatches = useMemo(() => {
    const query = textFilter.trim().toLowerCase();
    return (listQuery.data ?? []).filter((batch) => {
      if (scopedSet && !scopedSet.has(batch.id)) {
        return false;
      }
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

  return (
    <Stack gap="md">
      <Row align="center" justify="between" gap="sm" wrap>
        <p className="text-muted-foreground text-sm">
          Queue batches, per-job status, retries, and dev drain controls.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={drain.isPending}
          onClick={() => drain.mutate({ limit: 25 })}
        >
          {drain.isPending ? <Spinner className="size-3" /> : <StepForward />}
          Drain pending
        </Button>
      </Row>
      <Row gap="sm" wrap>
        <Input
          value={textFilter}
          onChange={(event) => setTextFilter(event.target.value)}
          placeholder="Filter source, entity, or id"
          className="max-w-sm"
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
      {scopedSet ? (
        <Row align="center" gap="sm" className="text-muted-foreground text-sm">
          <span>
            Showing {scopedSet.size} background{" "}
            {scopedSet.size === 1 ? "batch" : "batches"} from your last action.
          </span>
          <Link
            to="/background-jobs"
            // Clear only the scope filter; keep any open detail panel (batchId).
            search={(prev) => ({ batchId: prev.batchId })}
            className="underline decoration-dotted underline-offset-2 hover:decoration-primary"
          >
            Clear
          </Link>
        </Row>
      ) : null}
      {/* Hydration-stable: the server renders the spinner with no batches while
          the client's first render already has the streamed ones, so the
          spinner and the table have to be one chain rather than two
          independent branches. See useHydratedLoading. */}
      {listLoading ? (
        <Spinner />
      ) : listQuery.data ? (
        <BatchTable
          batches={filteredBatches}
          selectedBatchId={selectedBatchId}
        />
      ) : null}
      {selectedBatchId ? (
        <SelectedBatchDetail key={selectedBatchId} batchId={selectedBatchId} />
      ) : null}
    </Stack>
  );
}
