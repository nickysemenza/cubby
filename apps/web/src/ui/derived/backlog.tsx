import type { DerivedBacklog } from "@cubby/schemas/derived-backlog";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { humanize } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { derived } from "~/integrations/tanstack-query/generated/domains/derived.gen";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { DateDisplay } from "~/ui/common/date-display";
import { Facts } from "~/ui/common/facts";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { Disclosure } from "~/ui/layout/disclosure";
import { CrossTabTable } from "~/ui/matrix/cross-tab-table";
import { HEAT_CLASSES, heatBucket } from "~/ui/matrix/heat-scale";
import { totalCell } from "~/ui/matrix/matrix-chrome";
import { Button } from "~/ui/primitives/button";

import { type BacklogMatrix, pivotDerivedBacklog } from "./backlog-matrix";
import {
  backlogRefreshes,
  backlogStates,
  refreshStateSummary,
} from "./backlog-summary";

/** The shell status slot's derived backlog: shown only while values are updating. */
export function DerivedBacklogStatus({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { data } = useQuery({
    ...derived.backlog.queryOptions({}),
  });
  if (!data?.total) return null;
  const label = `${countLabel(data.total, "refresh")} pending`;
  return (
    <Link
      to="/activity"
      search={{ tab: "now" }}
      hash="derived-values"
      aria-label={compact ? label : undefined}
      className="grid w-full min-w-0 gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      {compact ? (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
      ) : (
        <span>{label}</span>
      )}
    </Link>
  );
}

export function DerivedBacklogOverview() {
  const result = useQuery({
    ...derived.backlog.queryOptions({}),
  });
  const matrix = result.data?.kinds.some((kind) => kind.count > 0)
    ? pivotDerivedBacklog({
        ...result.data,
        total: result.data.kinds.reduce((sum, kind) => sum + kind.count, 0),
      })
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
                  title: "derived values",
                  onRetry: () => void result.refetch(),
                }
              : { status: "success" }
        }
        empty={<span>No values waiting to update.</span>}
      >
        {result.data && result.data.total > 0 && (
          <RecordRow
            primary={`${countLabel(result.data.total, "refresh")} pending`}
            secondary={
              result.data.oldestWaitingSeconds === null
                ? undefined
                : `Oldest wait: ${formatCount(result.data.oldestWaitingSeconds)} seconds`
            }
          />
        )}
      </RecordList>
      {result.data && result.data.total > 0 ? (
        <DerivedRefreshStates
          backlog={result.data}
          observedAt={result.dataUpdatedAt}
        />
      ) : null}
      {matrix && <DerivedBacklogMatrix matrix={matrix} />}
    </div>
  );
}

function DerivedRefreshStates({
  backlog,
  observedAt,
}: {
  backlog: DerivedBacklog;
  observedAt: number;
}) {
  const rows = backlogRefreshes(backlog);
  const total = backlogStates(backlog);
  return (
    <div className="grid gap-1 text-xs">
      <p>
        {total.unknown > 0 ? "Known states: " : ""}
        {refreshStateSummary(total)}
      </p>
      {total.unknown > 0 && (
        <p>
          Execution state not reported for{" "}
          {countLabel(total.unknown, "refresh")}.
        </p>
      )}
      <p className="text-muted-foreground">
        Refresh work · Observed <DateDisplay timestamp={observedAt} />
      </p>
      <Disclosure summary="Refresh states by source">
        <RecordList empty="No refreshes waiting.">
          {rows.map((kind) => (
            <RecordRow
              key={kind.key}
              primary={kind.label}
              secondary={
                kind.states
                  ? refreshStateSummary(kind.states)
                  : "Execution state not reported"
              }
              detail={
                kind.refreshReasons?.length ? (
                  <fieldset
                    aria-label={`${kind.triggerLabel} refresh triggers`}
                  >
                    <Facts
                      layout="inline"
                      facts={kind.refreshReasons.map(({ reason, count }) => ({
                        label: reason ?? "Trigger not recorded",
                        value: formatCount(count),
                      }))}
                    />
                  </fieldset>
                ) : undefined
              }
              trailing={
                kind.nextAttemptAt ? (
                  <span>
                    Next attempt <DateDisplay timestamp={kind.nextAttemptAt} />
                  </span>
                ) : undefined
              }
            />
          ))}
        </RecordList>
      </Disclosure>
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
          renderRowHeader={(row) => entityRoster[row.data.entity].singular}
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
            return `${entityRoster[row.data.entity].singular} · ${humanize(column.key)}: ${formatCount(count)} updating`;
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
