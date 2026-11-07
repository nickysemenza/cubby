import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import {
  workRecordTypeOptions,
  type WorkQueueOut,
} from "@cubby/schemas/work-queue";
import { cn } from "cn";
import { useMemo, useState } from "react";

import type { GroupSummaryModel } from "~/entity/entity-list/group-drill-down";
import { EntityPivot } from "~/entity/entity-list/pivot/entity-pivot";
import type { PivotShare } from "~/entity/entity-list/pivot/pivot-model";
import { formatCount, formatPercent } from "~/lib/number-format";
import { CrossTabTable } from "~/ui/matrix/cross-tab-table";
import { heatBucket, HEAT_CLASSES } from "~/ui/matrix/heat-scale";
import { cellMono } from "~/ui/matrix/matrix-chrome";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

/** Queue counts adapt to the same full-population model as entity-list pivots. */
export function WorkQueueSummary({
  meta,
  pivot,
  isLoading,
  isTransitioning,
  error,
  onRetry,
  onDrill,
}: {
  meta:
    | Pick<WorkQueueOut["meta"], "totalCount" | "summary" | "reasons">
    | undefined;
  pivot: boolean;
  isLoading: boolean;
  isTransitioning: boolean;
  error: unknown;
  onRetry: () => void;
  onDrill: (path: readonly string[]) => void;
}) {
  const [share, setShare] = useState<PivotShare>("count");
  const current = isTransitioning ? undefined : meta;
  const model = useMemo<GroupSummaryModel | undefined>(() => {
    if (!current?.summary) return undefined;
    const totals = new Map<string, number>();
    for (const cell of current.summary.cells)
      totals.set(cell.reason, (totals.get(cell.reason) ?? 0) + cell.count);
    const overlapping =
      [...totals.values()].reduce((sum, value) => sum + value, 0) >
      current.totalCount;
    const reasonLabel = (key: string) =>
      current.reasons.find((reason) => reason.value === key)?.label ?? key;
    const typeLabel = (key: string | null) =>
      workRecordTypeOptions.find((type) => type.value === key)?.label ??
      "Problem";
    const group = (
      path: string[],
      label: string,
      count: number,
      parentCount: number,
    ): ListGroupSummary => ({
      key: JSON.stringify(path),
      path,
      label,
      count,
      parentCount,
      fraction: parentCount > 0 ? count / parentCount : null,
      overlapping,
    });
    return {
      groupBy: [{ key: "reason" }, { key: "recordType" }],
      groups: [
        ...[...totals].map(([reason, count]) =>
          group([reason], reasonLabel(reason), count, current.totalCount),
        ),
        ...current.summary.cells.map((cell) =>
          group(
            [cell.reason, cell.entity ?? FILTER_NONE],
            typeLabel(cell.entity),
            cell.count,
            totals.get(cell.reason) ?? 0,
          ),
        ),
      ],
      margins: current.summary.types.map((type) => ({
        dimensions: [1],
        path: [type.entity ?? FILTER_NONE],
        count: type.count,
      })),
      totalCount: current.totalCount,
      drillFilters: (path) =>
        path.map((key, depth) => ({
          id: depth === 0 ? "reason" : "entity",
          value: [key],
        })),
      drill: onDrill,
    };
  }, [current, onDrill]);
  if (pivot)
    return (
      <EntityPivot
        labels={["Reason", "Type"]}
        recordLabel={{ one: "work item", other: "work items" }}
        summary={model}
        isLoading={isLoading}
        isTransitioning={isTransitioning}
        error={error}
        onRetry={onRetry}
        share={share}
        onShareChange={setShare}
        onDrill={onDrill}
      />
    );

  const rows = (
    model?.groups.filter((group) => group.path.length === 1) ?? []
  ).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const max = Math.max(0, ...rows.map((row) => row.count));
  return (
    <div className="min-w-0 p-2 md:p-4">
      <Visualization
        state={visualizationState({
          data: model,
          isLoading: isLoading || isTransitioning,
          error,
          empty: rows.length === 0,
          onRetry,
        })}
        message="No known work matches these filters."
      >
        <CrossTabTable
          caption="Work items by reason"
          surface="background"
          rowHover
          bareCells
          cornerLabel="Reason"
          columns={[
            { key: "count", data: "count" },
            { key: "share", data: "share" },
          ]}
          rows={rows.map((row) => ({ key: row.key, data: row }))}
          renderColumnHeader={(column) =>
            column.key === "count" ? "Work items" : "Share of total"
          }
          renderRowHeader={({ data }) => (
            <span className="block max-w-prose text-wrap">{data.label}</span>
          )}
          renderCell={({ data }, column) => (
            <button
              type="button"
              className={cn(
                cellMono,
                "block w-full hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                column.key === "count" &&
                  HEAT_CLASSES[heatBucket(data.count, max)],
              )}
              aria-label={`${data.label}: ${formatCount(data.count)} work items. Open in table`}
              onClick={() => onDrill(data.path)}
            >
              {column.key === "count"
                ? formatCount(data.count)
                : formatPercent(data.count / (current?.totalCount || 1))}
            </button>
          )}
          footer={[
            {
              key: "total",
              label: "Total work items",
              cell: (key) =>
                key === "count"
                  ? formatCount(current?.totalCount ?? 0)
                  : "100%",
            },
          ]}
        />
      </Visualization>
      <p className="mt-2 text-xs text-muted-foreground">
        Counts cover all matching work items. One record may have several work
        items.{" "}
        {model?.groups.some((group) => group.overlapping) &&
          "An item can appear under several reasons; the total counts it once."}{" "}
        Select a count to open its records.
      </p>
    </div>
  );
}
