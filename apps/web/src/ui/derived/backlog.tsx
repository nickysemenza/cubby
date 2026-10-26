import { entitySummary } from "@cubby/schemas/entity-summary";
import { humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { derived } from "~/integrations/tanstack-query/generated/catalog/derived.gen";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { CrossTabTable } from "~/ui/matrix/cross-tab-table";
import { HEAT_CLASSES, heatBucket } from "~/ui/matrix/heat-scale";
import { totalCell } from "~/ui/matrix/matrix-chrome";
import { Button } from "~/ui/primitives/button";

import { type BacklogMatrix, pivotDerivedBacklog } from "./backlog-matrix";
import {
  backlogEstimate,
  type BacklogSample,
  sampleBacklog,
} from "./backlog-progress";

/** The shell status slot's derived backlog: shown only while values are updating. */
export function DerivedBacklogStatus({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { data } = useQuery(derived.backlog.queryOptions({}));
  if (!data?.total) return null;
  const label = `Updating ${data.total} values`;
  return (
    <Link
      to="/activity"
      hash="derived-values"
      aria-label={compact ? label : undefined}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
      {!compact && <span>{label}</span>}
    </Link>
  );
}

export function DerivedBacklogOverview() {
  const result = useQuery({
    ...derived.backlog.queryOptions({}),
    refetchInterval: 15_000,
  });
  const [observed, setObserved] = useState(0);
  const [samples, setSamples] = useState<readonly BacklogSample[]>([]);
  if (result.isSuccess && result.dataUpdatedAt !== observed) {
    setObserved(result.dataUpdatedAt);
    setSamples(
      sampleBacklog(samples, {
        at: result.dataUpdatedAt,
        total: result.data.total,
      }),
    );
  }
  const estimate = backlogEstimate(samples);
  const firstSample = samples[0];
  const lastSample = samples.at(-1);
  const hasWindow =
    firstSample && lastSample && lastSample.at - firstSample.at >= 60_000;
  const minutes = estimate
    ? Math.max(1, Math.ceil(estimate.seconds / 60))
    : null;
  const duration =
    minutes === null
      ? null
      : minutes < 60
        ? `${minutes} min`
        : `${Math.ceil(minutes / 60)} h`;
  const matrix =
    result.data && result.data.total > 0
      ? pivotDerivedBacklog(result.data)
      : null;
  return (
    <div className="flex flex-col gap-3">
      <RecordList
        state={
          result.isPending
            ? { status: "pending", rows: 2 }
            : result.isError
              ? {
                  status: "error",
                  error: result.error,
                  title: "Couldn't load derived values",
                  onRetry: () => void result.refetch(),
                }
              : { status: "success" }
        }
        empty={<span>No values waiting to update.</span>}
      >
        {result.data && result.data.total > 0 && (
          <RecordRow
            primary={`${formatCount(result.data.total)} values remaining`}
            trailing={
              result.isError
                ? "Estimate unavailable"
                : duration
                  ? `About ${duration} remaining`
                  : hasWindow
                    ? "No ETA yet"
                    : "Estimating…"
            }
            secondary={
              estimate && !result.isError
                ? `${formatCount(Math.round(estimate.perMinute))} fewer/min while this page is open. New work can change the estimate.`
                : hasWindow
                  ? "The backlog is not decreasing over recent samples."
                  : "Needs at least a minute of decreasing backlog while this page is open."
            }
          />
        )}
      </RecordList>
      {matrix && <DerivedBacklogMatrix matrix={matrix} />}
    </div>
  );
}

const PINNED = [{ key: "total", label: "Total", className: totalCell }];

/**
 * Entity x derived kind; `·` marks a kind the entity does not declare. Idle
 * rows and columns stay behind the toggle so outstanding work reads first.
 */
function DerivedBacklogMatrix({ matrix }: { matrix: BacklogMatrix }) {
  const [showIdle, setShowIdle] = useState(false);
  const idleRows = matrix.rows.filter((row) => row.total === 0).length;
  const columns = matrix.fields
    .filter((field) => showIdle || (matrix.fieldTotals.get(field) ?? 0) > 0)
    .map((field) => ({ key: field, data: field }));
  const rows = matrix.rows
    .filter((row) => showIdle || row.total > 0)
    .map((row) => ({ key: row.entity, data: row }));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.length > 0 && (
        <CrossTabTable
          caption="Derived values updating, by record type and value"
          cornerLabel="Record"
          columns={columns}
          rows={rows}
          surface="background"
          rowHover
          renderColumnHeader={(column) => humanize(column.data)}
          renderRowHeader={(row) => entitySummary[row.data.entity].singular}
          renderCell={(row, column) => {
            const count = row.data.counts.get(column.key);
            return count === undefined ? null : formatCount(count);
          }}
          cellClassName={(row, column) => {
            const count = row.data.counts.get(column.key);
            if (count === undefined) return undefined;
            return count === 0
              ? "text-muted-foreground/60"
              : HEAT_CLASSES[heatBucket(count, matrix.max)];
          }}
          cellTitle={(row, column) => {
            const count = row.data.counts.get(column.key);
            if (count === undefined) return undefined;
            return `${entitySummary[row.data.entity].singular} · ${humanize(column.key)}: ${formatCount(count)} updating`;
          }}
          pinned={PINNED}
          renderPinnedCell={(row) => (
            <span
              className={cn(row.data.total === 0 && "text-muted-foreground/60")}
            >
              {formatCount(row.data.total)}
            </span>
          )}
          footer={[
            {
              key: "total",
              label: "Total",
              cell: (field) => formatCount(matrix.fieldTotals.get(field) ?? 0),
              pinnedCell: () => formatCount(matrix.attributed),
              cellClassName: totalCell,
            },
          ]}
        />
      )}
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        {matrix.unattributed > 0 ? (
          <p className="text-xs text-muted-foreground">
            {formatCount(matrix.unattributed)} more queued values don't match a
            declared derived value.
          </p>
        ) : (
          <span />
        )}
        {(idleRows > 0 || columns.length < matrix.fields.length) && (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showIdle}
            onClick={() => setShowIdle(!showIdle)}
          >
            {showIdle
              ? "Hide idle values"
              : `Show all ${formatCount(matrix.rows.length)} record types`}
          </Button>
        )}
      </div>
    </div>
  );
}
