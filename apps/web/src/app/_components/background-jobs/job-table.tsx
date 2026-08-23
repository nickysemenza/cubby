import {
  type BackgroundJobSummary,
  backgroundJobPayloadSchema as parseBackgroundJobPayload,
} from "@cubby/schemas/background-jobs";
import { RotateCcw } from "lucide-react";
import { match } from "ts-pattern";
import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import {
  CopyDebugButton,
  CopyJsonButton,
} from "~/app/_components/recipe/copy-debug-button";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { formatMs } from "./format";

type ParsedBackgroundJobPayload = ReturnType<
  typeof parseBackgroundJobPayload.parse
>;

function formatRelativeDuration(start: Date | null, end: Date | null): string {
  if (!start || !end) return "";
  return formatMs(Math.max(0, end.getTime() - start.getTime()));
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

  return match(parsed)
    .with({ kind: "entity-embedding.refresh" }, (p) => (
      <EntityInlineLinkById
        entityType={p.payload.entityType}
        entityId={p.payload.entityId}
        compact
      />
    ))
    .with({ kind: "entity-embedding.backfill.coordinator" }, () => (
      <span>Continue semantic backfill</span>
    ))
    .with({ kind: "search-document.repair.coordinator" }, () => (
      <span>Continue search-document repair</span>
    ))
    .with(
      { kind: "location-ai.description.refresh" },
      { kind: "location-ai.inventory.refresh" },
      (p) => (
        <EntityInlineLinkById
          entityType="location"
          entityId={p.payload.locationId}
          compact
        />
      ),
    )
    .with({ kind: "recipe-totals.recompute" }, (p) => {
      const [firstRecipeId] = p.payload.recipeIds;
      if (p.payload.recipeIds.length === 1 && firstRecipeId) {
        return (
          <EntityInlineLinkById
            entityType="recipe"
            entityId={firstRecipeId}
            compact
          />
        );
      }
      const previewRecipeIds = p.payload.recipeIds.slice(0, 3);
      const remaining = p.payload.recipeIds.length - previewRecipeIds.length;
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
    })
    .with({ kind: "location-valuation.recompute" }, () => (
      <span>All locations</span>
    ))
    .with({ kind: "problems.counts.refresh" }, () => (
      <span>Problem counts</span>
    ))
    .with({ kind: "usda-match.retry" }, (p) => (
      <EntityInlineLinkById
        entityType="ingredient"
        entityId={p.payload.ingredientId}
        compact
      />
    ))
    .exhaustive();
}

function JobPayloadSummary({ job }: { job: BackgroundJobSummary }) {
  const parsed = parseJobPayload(job);
  if (!parsed)
    return <span className="text-muted-foreground">Invalid JSON</span>;

  return match(parsed)
    .with({ kind: "entity-embedding.refresh" }, (p) => (
      <span>
        {p.payload.entityType} · {p.payload.entityId.slice(0, 8)}
      </span>
    ))
    .with({ kind: "entity-embedding.backfill.coordinator" }, () => (
      <span>Semantic backfill page</span>
    ))
    .with({ kind: "search-document.repair.coordinator" }, () => (
      <span>Search-document repair page</span>
    ))
    .with(
      { kind: "location-ai.description.refresh" },
      { kind: "location-ai.inventory.refresh" },
      (p) => <span>location · {p.payload.locationId.slice(0, 8)}</span>,
    )
    .with({ kind: "recipe-totals.recompute" }, (p) => (
      <span>{p.payload.recipeIds.length} recipe ids</span>
    ))
    .with({ kind: "location-valuation.recompute" }, (p) => (
      <span>{p.payload.reason ?? "no reason"}</span>
    ))
    .with({ kind: "problems.counts.refresh" }, (p) => (
      <span>requested · {p.payload.requestedAt}</span>
    ))
    .with({ kind: "usda-match.retry" }, (p) => (
      <span>ingredient · {p.payload.ingredientId.slice(0, 8)}</span>
    ))
    .exhaustive();
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
        {jobs.map((job) => (
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
        {jobs.length === 0 ? (
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

export { JobTable };
