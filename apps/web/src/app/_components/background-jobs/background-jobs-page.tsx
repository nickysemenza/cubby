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
import { useMemo, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import { BatchDetail } from "./batch-detail";
import { batchFilterText } from "./batch-metadata";
import { BatchTable } from "./batch-table";

const ALL_FILTER_VALUE = "all";

// Poll cadence while a batch is still working. Fast enough that a batch you
// followed from a toast link visibly progresses; slow enough not to hammer the
// queue tables.
const BATCH_POLL_MS = 4000;

// A batch is "live" (worth polling) until it reaches a terminal state. queued and
// running are in-flight; succeeded/partial/failed/cancelled are settled.
function isBatchLive(status: BackgroundBatchStatus): boolean {
  return status === "queued" || status === "running";
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
  const detailQuery = useQuery({
    ...api.backgroundJobs.getBatch.queryOptions({
      batchId: selectedBatchId ?? "",
    }),
    enabled: Boolean(selectedBatchId),
    refetchInterval: (query) =>
      query.state.data && isBatchLive(query.state.data.status)
        ? BATCH_POLL_MS
        : false,
  });

  const invalidate = async () => {
    const keys: QueryKey[] = [api.backgroundJobs.listBatches.queryKey()];
    if (selectedBatchId) {
      keys.push(
        api.backgroundJobs.getBatch.queryKey({
          batchId: selectedBatchId,
        }),
      );
    }
    invalidateTRPCQueries(queryClient, keys);
  };

  const retry = useMutation(
    api.backgroundJobs.retryBatch.mutationOptions({ onSuccess: invalidate }),
  );
  const retryJob = useMutation(
    api.backgroundJobs.retryJob.mutationOptions({ onSuccess: invalidate }),
  );
  const cancel = useMutation(
    api.backgroundJobs.cancelBatch.mutationOptions({ onSuccess: invalidate }),
  );
  const drain = useMutation(
    api.backgroundJobs.drain.mutationOptions({ onSuccess: invalidate }),
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
        <select
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value)}
          className="border border-input bg-background px-2 py-1 text-sm"
        >
          <option value={ALL_FILTER_VALUE}>All kinds</option>
          {backgroundJobKinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <select
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value)}
          className="border border-input bg-background px-2 py-1 text-sm"
        >
          <option value={ALL_FILTER_VALUE}>All sources</option>
          {backgroundBatchSources.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
        <select
          value={processorFilter}
          onChange={(event) => setProcessorFilter(event.target.value)}
          className="border border-input bg-background px-2 py-1 text-sm"
        >
          <option value={ALL_FILTER_VALUE}>All processors</option>
          {backgroundBatchProcessors.map((processor) => (
            <option key={processor} value={processor}>
              {processor}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="border border-input bg-background px-2 py-1 text-sm"
        >
          <option value={ALL_FILTER_VALUE}>All statuses</option>
          {backgroundBatchStatuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
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
      {listQuery.isLoading ? <Spinner /> : null}
      {listQuery.data ? (
        <BatchTable
          batches={filteredBatches}
          selectedBatchId={selectedBatchId}
        />
      ) : null}
      {detailQuery.isLoading ? <Spinner /> : null}
      {detailQuery.data ? (
        <BatchDetail
          batch={detailQuery.data}
          onRetry={() => retry.mutate({ batchId: detailQuery.data.id })}
          onCancel={() => cancel.mutate({ batchId: detailQuery.data.id })}
          onRetryJob={(jobId) => retryJob.mutate({ jobId })}
        />
      ) : null}
    </Stack>
  );
}
