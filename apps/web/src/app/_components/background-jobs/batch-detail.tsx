import type { BackgroundBatchDetail } from "@cubby/schemas/background-jobs";
import { AlertTriangle, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import { CopyJsonButton } from "~/app/_components/recipe/copy-debug-button";
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
import {
  formatMetadataValue,
  isRecord,
  parseBackgroundEntityRef,
} from "./batch-metadata";
import { OriginLink } from "./batch-table";
import { formatDate, formatMs } from "./format";
import { JobTable } from "./job-table";

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
        <summary className="eyebrow cursor-pointer font-semibold">
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

export { BatchDetail };
