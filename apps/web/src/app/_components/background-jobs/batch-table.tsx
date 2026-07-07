import type { BackgroundBatchSummary } from "@cubby/schemas/background-jobs";
import { Link } from "@tanstack/react-router";
import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import { Row } from "~/components/layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { isRecord, parseBackgroundEntityRef } from "./batch-metadata";
import { formatDate, formatMs } from "./format";

function BatchStatus({ batch }: { batch: BackgroundBatchSummary }) {
  return (
    <span className="font-medium">
      {batch.status} · {batch.succeededJobs + batch.skippedJobs}/
      {batch.totalJobs}
      {batch.failedJobs > 0 ? ` · ${batch.failedJobs} failed` : ""}
    </span>
  );
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
                search={(prev) => ({ ...prev, batchId: batch.id })}
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

export { BatchTable, OriginLink };
