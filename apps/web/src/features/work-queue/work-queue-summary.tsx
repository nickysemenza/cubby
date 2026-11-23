import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import {
  workRecordTypeOptions,
  type WorkQueueOut,
} from "@cubby/schemas/work-queue";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { type ReactNode, useMemo, useState } from "react";

import type { GroupSummaryModel } from "~/entity/entity-list/group-drill-down";
import { EntityPivot } from "~/entity/entity-list/pivot/entity-pivot";
import type { PivotShare } from "~/entity/entity-list/pivot/pivot-model";
import { formatCalendarDay } from "~/lib/date-format";
import { formatCount, formatPercent } from "~/lib/number-format";
import {
  type IndexedSection,
  LedgerCard,
  RecordSectionControlsContext,
  useSectionOpenState,
} from "~/ui/data-table/indexed-sections";
import { Button } from "~/ui/primitives/button";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

const NO_FOLDED: IndexedSection[] = [];
const closedByDefault = () => false;
const ignoreUnfold = () => undefined;

/**
 * Queue counts adapt to the same full-population model as entity-list pivots.
 * Summary is one card of ledger rows, one per reason: its share and oldest
 * record day as the digest, its count as the figure, and its records in place
 * once opened.
 */
export function WorkQueueSummary({
  meta,
  pivot,
  isLoading,
  isTransitioning,
  error,
  onRetry,
  onDrill,
  renderRecords,
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
  /** One reason's records, mounted only while its row is open. */
  renderRecords: (reason: string) => ReactNode;
}) {
  const [share, setShare] = useState<PivotShare>("count");
  // Rows mount their records only once opened, and unmount when closed.
  const { controls } = useSectionOpenState(null, closedByDefault, false);
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
  const oldest = useMemo(() => {
    const byReason = new Map<string, string>();
    for (const cell of current?.summary?.cells ?? []) {
      const prior = byReason.get(cell.reason);
      if (cell.oldest && (!prior || cell.oldest < prior))
        byReason.set(cell.reason, cell.oldest);
    }
    return byReason;
  }, [current]);
  if (pivot)
    return (
      <div className="p-3.5 md:p-4">
        <div className="record-card overflow-hidden p-0!">
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
        </div>
      </div>
    );

  const rows = (
    model?.groups.filter((group) => group.path.length === 1) ?? []
  ).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const total = current?.totalCount ?? 0;
  const sections = rows.map((row): IndexedSection => {
    const reason = row.path[0] ?? "";
    const since = oldest.get(reason);
    return {
      id: `work-reason-${reason.replaceAll(/[^\w-]/gu, "-")}`,
      title: row.label,
      icon: TrayIcon,
      count: row.count,
      digest: [
        `${formatPercent(row.count / (total || 1))} of work`,
        since ? `oldest from ${formatCalendarDay(since, "dateShort")}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      headerAction: (
        <Button variant="ghost" size="xs" onClick={() => onDrill(row.path)}>
          Open in Records
        </Button>
      ),
      content: renderRecords(reason),
    };
  });
  return (
    <div className="record-cards @container/record p-3.5 md:p-4">
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
        <RecordSectionControlsContext.Provider value={controls}>
          <LedgerCard
            title="Work by reason"
            caption={
              <>
                <span className="font-mono font-semibold text-foreground-strong tabular-nums">
                  {formatCount(total)}
                </span>{" "}
                work {total === 1 ? "item" : "items"}. One record may have
                several.{" "}
                {model?.groups.some((group) => group.overlapping) &&
                  "An item can appear under several reasons; the total counts it once."}{" "}
                Open a reason to see its records.
              </>
            }
            sections={sections}
            folded={NO_FOLDED}
            pending={0}
            onUnfold={ignoreUnfold}
          />
        </RecordSectionControlsContext.Provider>
      </Visualization>
    </div>
  );
}
