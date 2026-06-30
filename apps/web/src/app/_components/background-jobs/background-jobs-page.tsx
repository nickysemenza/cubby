import { type AuditEntityType, auditEntitySchema } from "@cubby/schemas/audit";
import {
  type BackgroundBatchDetail,
  type BackgroundBatchSummary,
  type BackgroundJobSummary,
  backgroundBatchProcessors,
  backgroundBatchSources,
  backgroundBatchStatuses,
  backgroundJobKinds,
  backgroundJobPayloadSchema as parseBackgroundJobPayload,
} from "@cubby/schemas/background-jobs";
import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, RotateCcw, Square, StepForward } from "lucide-react";
import { useMemo, useState } from "react";
import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import {
  CopyDebugButton,
  CopyJsonButton,
} from "~/app/_components/recipe/copy-debug-button";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

type ParsedBackgroundJobPayload = ReturnType<
  typeof parseBackgroundJobPayload.parse
>;

const ALL_FILTER_VALUE = "all";

function formatMs(value: number | null): string {
  if (value == null) return "";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatDate(value: Date | null): string {
  return value ? value.toLocaleString() : "";
}

function formatRelativeDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return "";
  return formatMs(Math.max(0, end.getTime() - start.getTime()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface BackgroundEntityRef {
  entityType: AuditEntityType;
  entityId: string;
}

function parseBackgroundEntityRef(value: unknown): BackgroundEntityRef | null {
  if (!isRecord(value)) return null;
  const { entityType, entityId } = value;
  if (typeof entityType !== "string" || typeof entityId !== "string") {
    return null;
  }
  const parsedEntityType = auditEntitySchema.safeParse(entityType);
  if (!parsedEntityType.success) return null;
  return { entityType: parsedEntityType.data, entityId };
}

function formatMetadataValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function BatchStatus({ batch }: { batch: BackgroundBatchSummary }) {
  return (
    <span className="font-medium">
      {batch.status} · {batch.succeededJobs + batch.skippedJobs}/
      {batch.totalJobs}
      {batch.failedJobs > 0 ? ` · ${batch.failedJobs} failed` : ""}
    </span>
  );
}

function batchFilterText(batch: BackgroundBatchSummary): string {
  const metadata = isRecord(batch.metadata) ? batch.metadata : null;
  const entity = parseBackgroundEntityRef(metadata?.entity);
  return [
    batch.id,
    batch.kind,
    batch.source,
    batch.processor,
    batch.status,
    typeof metadata?.source === "string" ? metadata.source : "",
    entity?.entityType ?? "",
    entity?.entityId ?? "",
    JSON.stringify(batch.metadata ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}

function OriginLink({ batch }: { batch: BackgroundBatchSummary }) {
  const metadata = isRecord(batch.metadata) ? batch.metadata : null;
  const source = typeof metadata?.source === "string" ? metadata.source : null;
  const entity = parseBackgroundEntityRef(metadata?.entity);

  if (source || entity) {
    return (
      <Row gap="sm" wrap>
        <span>{source ?? batch.source}</span>
        {entity ? (
          <EntityInlineLinkById
            entityType={entity.entityType}
            entityId={entity.entityId}
            compact
          />
        ) : null}
      </Row>
    );
  }

  if (
    batch.source === "backfill" &&
    batch.kind === "entity-embedding.refresh"
  ) {
    return (
      <Link
        to="/search/debug"
        className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
      >
        Search debug
      </Link>
    );
  }

  if (
    batch.source === "backfill" &&
    batch.kind === "location-ai.description.refresh"
  ) {
    return <span>Location AI backfill</span>;
  }

  return <span className="text-muted-foreground">Not recorded</span>;
}

function BatchTable({
  batches,
  selectedBatchId,
}: {
  batches: BackgroundBatchSummary[];
  selectedBatchId?: string;
}) {
  return (
    <Table className="table-auto">
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Processor</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Origin</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Wall</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.map((batch) => (
          <TableRow
            key={batch.id}
            data-state={batch.id === selectedBatchId ? "selected" : undefined}
          >
            <TableCell>
              <Link
                to="/background-jobs"
                search={{ batchId: batch.id }}
                className="font-mono text-xs underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
              >
                {batch.id.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell className="whitespace-normal">{batch.kind}</TableCell>
            <TableCell>{batch.processor}</TableCell>
            <TableCell>{batch.source}</TableCell>
            <TableCell className="whitespace-normal">
              <OriginLink batch={batch} />
            </TableCell>
            <TableCell>
              <BatchStatus batch={batch} />
            </TableCell>
            <TableCell>{formatMs(batch.wallDurationMs)}</TableCell>
            <TableCell>{formatDate(batch.createdAt)}</TableCell>
          </TableRow>
        ))}
        {batches.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="text-muted-foreground">
              No background batches
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function parseJobPayload(
  job: BackgroundJobSummary,
): ParsedBackgroundJobPayload | null {
  const result = parseBackgroundJobPayload.safeParse({
    kind: job.kind,
    payload: job.payload,
  });
  return result.success ? result.data : null;
}

function JobTarget({ job }: { job: BackgroundJobSummary }) {
  const parsed = parseJobPayload(job);
  if (!parsed) {
    return <span className="text-muted-foreground">Unparseable payload</span>;
  }

  switch (parsed.kind) {
    case "entity-embedding.refresh":
      return (
        <EntityInlineLinkById
          entityType={parsed.payload.entityType}
          entityId={parsed.payload.entityId}
          compact
        />
      );
    case "location-ai.description.refresh":
    case "location-ai.inventory.refresh":
      return (
        <EntityInlineLinkById
          entityType="location"
          entityId={parsed.payload.locationId}
          compact
        />
      );
    case "recipe-totals.recompute": {
      const [firstRecipeId] = parsed.payload.recipeIds;
      if (parsed.payload.recipeIds.length === 1 && firstRecipeId) {
        return (
          <EntityInlineLinkById
            entityType="recipe"
            entityId={firstRecipeId}
            compact
          />
        );
      }
      const previewRecipeIds = parsed.payload.recipeIds.slice(0, 3);
      const remaining =
        parsed.payload.recipeIds.length - previewRecipeIds.length;
      return (
        <Row gap="sm" wrap>
          {previewRecipeIds.map((recipeId) => (
            <EntityInlineLinkById
              key={recipeId}
              entityType="recipe"
              entityId={recipeId}
              compact
            />
          ))}
          {remaining > 0 ? (
            <span className="text-muted-foreground">+{remaining} more</span>
          ) : null}
        </Row>
      );
    }
    case "location-valuation.recompute":
      return <span>All locations</span>;
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

function JobPayloadSummary({ job }: { job: BackgroundJobSummary }) {
  const parsed = parseJobPayload(job);
  if (!parsed)
    return <span className="text-muted-foreground">Invalid JSON</span>;

  switch (parsed.kind) {
    case "entity-embedding.refresh":
      return (
        <span>
          {parsed.payload.entityType} · {parsed.payload.entityId.slice(0, 8)}
        </span>
      );
    case "location-ai.description.refresh":
    case "location-ai.inventory.refresh":
      return <span>location · {parsed.payload.locationId.slice(0, 8)}</span>;
    case "recipe-totals.recompute":
      return <span>{parsed.payload.recipeIds.length} recipe ids</span>;
    case "location-valuation.recompute":
      return <span>{parsed.payload.reason ?? "no reason"}</span>;
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

function JobStatus({ job }: { job: BackgroundJobSummary }) {
  const className =
    job.status === "failed"
      ? "font-medium text-destructive"
      : job.status === "queued" || job.status === "pending"
        ? "font-medium text-muted-foreground"
        : "font-medium";
  return <span className={className}>{job.status}</span>;
}

function JobTable({
  jobs,
  showFailedOnly,
  onRetryJob,
}: {
  jobs: BackgroundJobSummary[];
  showFailedOnly: boolean;
  onRetryJob: (jobId: string) => void;
}) {
  const displayedJobs = useMemo(() => {
    const filtered = showFailedOnly
      ? jobs.filter((job) => job.status === "failed")
      : jobs;
    return [...filtered].sort((a, b) => {
      if (a.status === "failed" && b.status !== "failed") return -1;
      if (a.status !== "failed" && b.status === "failed") return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  }, [jobs, showFailedOnly]);

  return (
    <Table className="table-auto">
      <TableHeader>
        <TableRow>
          <TableHead>Job</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Attempts</TableHead>
          <TableHead>Wait</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Error</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {displayedJobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell className="whitespace-normal">
              <Stack gap="tight">
                <span className="font-mono text-xs">{job.id.slice(0, 8)}</span>
                <span className="text-muted-foreground text-xs">
                  {job.kind}
                </span>
              </Stack>
            </TableCell>
            <TableCell className="whitespace-normal">
              <Stack gap="tight">
                <JobTarget job={job} />
                <span className="text-muted-foreground text-xs">
                  <JobPayloadSummary job={job} />
                </span>
              </Stack>
            </TableCell>
            <TableCell>
              <JobStatus job={job} />
            </TableCell>
            <TableCell>
              {job.attempts}/{job.maxAttempts}
            </TableCell>
            <TableCell>
              {formatRelativeDuration(job.queuedAt, job.startedAt)}
            </TableCell>
            <TableCell>{formatMs(job.durationMs)}</TableCell>
            <TableCell className="max-w-96 whitespace-normal text-muted-foreground">
              {job.lastError ? (
                <Stack gap="tight">
                  <span>{job.lastError}</span>
                  <CopyDebugButton
                    getText={() => job.lastError ?? ""}
                    label="Copy error"
                    title="Copy full job error"
                    toastLabel="Copied job error"
                  />
                </Stack>
              ) : (
                ""
              )}
            </TableCell>
            <TableCell>
              <Row gap="sm" wrap>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={job.status !== "failed"}
                  onClick={() => onRetryJob(job.id)}
                >
                  <RotateCcw />
                  Retry
                </Button>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Payload
                  </summary>
                  <Stack gap="tight" className="mt-2">
                    <CopyJsonButton
                      value={job.payload}
                      label="Copy payload"
                      title="Copy raw job payload"
                      toastLabel="Copied job payload"
                    />
                    <pre className="max-h-48 max-w-96 overflow-auto whitespace-pre-wrap bg-muted p-2 text-xs">
                      {JSON.stringify(job.payload, null, 2)}
                    </pre>
                  </Stack>
                </details>
              </Row>
            </TableCell>
          </TableRow>
        ))}
        {displayedJobs.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="text-muted-foreground">
              {showFailedOnly ? "No failed jobs" : "No jobs"}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function MetadataTable({ value }: { value: unknown }) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return <p className="text-muted-foreground text-sm">No metadata</p>;
  }

  const renderValue = (key: string, metadataValue: unknown) => {
    const entity =
      key === "entity" ? parseBackgroundEntityRef(metadataValue) : null;
    if (entity) {
      return (
        <EntityInlineLinkById
          entityType={entity.entityType}
          entityId={entity.entityId}
          compact
        />
      );
    }
    return formatMetadataValue(metadataValue);
  };

  return (
    <Table className="table-auto">
      <TableHeader>
        <TableRow>
          <TableHead>Key</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Object.entries(value).map(([key, metadataValue]) => (
          <TableRow key={key}>
            <TableCell className="font-mono text-xs">{key}</TableCell>
            <TableCell className="whitespace-normal">
              {renderValue(key, metadataValue)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BatchDetail({
  batch,
  onRetry,
  onCancel,
  onRetryJob,
}: {
  batch: BackgroundBatchDetail;
  onRetry: () => void;
  onCancel: () => void;
  onRetryJob: (jobId: string) => void;
}) {
  const [showFailedOnly, setShowFailedOnly] = useState(false);

  return (
    <Stack gap="sm" className="border border-border bg-card p-4">
      <Row align="center" justify="between" gap="sm" wrap>
        <div>
          <h2 className="font-semibold">{batch.kind}</h2>
          <p className="font-mono text-muted-foreground text-xs">{batch.id}</p>
        </div>
        <Row gap="sm">
          <Button
            type="button"
            variant={showFailedOnly ? "default" : "outline"}
            onClick={() => setShowFailedOnly((value) => !value)}
          >
            <AlertTriangle />
            Failed only
          </Button>
          <Button type="button" variant="outline" onClick={onRetry}>
            <RotateCcw />
            Retry failed
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            <Square />
            Cancel queued
          </Button>
        </Row>
      </Row>
      <Row gap="md" wrap className="text-sm">
        <span>Status: {batch.status}</span>
        <span>Processor: {batch.processor}</span>
        <span>Source: {batch.source}</span>
        <span>
          Origin: <OriginLink batch={batch} />
        </span>
        <span>Wall: {formatMs(batch.wallDurationMs)}</span>
        <span>Processing: {formatMs(batch.processingDurationMs)}</span>
        <span>Active: {formatMs(batch.activeDurationMs)}</span>
      </Row>
      <Row gap="md" wrap className="text-muted-foreground text-sm">
        <span>First queued: {formatDate(batch.firstEnqueuedAt)}</span>
        <span>Last queued: {formatDate(batch.lastEnqueuedAt)}</span>
        <span>First started: {formatDate(batch.firstJobStartedAt)}</span>
        <span>Last finished: {formatDate(batch.lastJobFinishedAt)}</span>
      </Row>
      <details>
        <summary className="cursor-pointer font-mono font-semibold text-muted-foreground text-xs uppercase tracking-wide">
          Metadata
        </summary>
        <Stack gap="sm" className="mt-2">
          <CopyJsonButton
            value={batch.metadata}
            label="Copy metadata"
            title="Copy raw batch metadata"
            toastLabel="Copied batch metadata"
          />
          <MetadataTable value={batch.metadata} />
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap bg-muted p-2 text-xs">
            {JSON.stringify(batch.metadata, null, 2)}
          </pre>
        </Stack>
      </details>
      <JobTable
        jobs={batch.jobs}
        showFailedOnly={showFailedOnly}
        onRetryJob={onRetryJob}
      />
    </Stack>
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
  const listQuery = useQuery(
    api.backgroundJobs.listBatches.queryOptions({ limit: 25 }),
  );
  const detailQuery = useQuery({
    ...api.backgroundJobs.getBatch.queryOptions({
      batchId: selectedBatchId ?? "",
    }),
    enabled: Boolean(selectedBatchId),
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
