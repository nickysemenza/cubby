import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { GridNineIcon } from "@phosphor-icons/react/dist/csr/GridNine";
import { cn } from "cn";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";

import type { GroupSummaryModel } from "~/entity/entity-list/group-drill-down";
import { GroupValueLabel } from "~/entity/entity-list/group-value-label";
import { ListMetricValue } from "~/entity/entity-list/list-evidence-summary";
import {
  formatCount,
  formatCurrency,
  formatPercent,
} from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { CrossTabTable } from "~/ui/matrix/cross-tab-table";
import type { CrossTabColumn } from "~/ui/matrix/group-columns";
import { HEAT_CLASSES, heatBucket } from "~/ui/matrix/heat-scale";
import {
  cellMono,
  EMPTY_MARK,
  emptyCell,
  totalCell,
} from "~/ui/matrix/matrix-chrome";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

import {
  buildPivot,
  OTHER_COLUMN,
  PIVOT_SHARES,
  pivotBasis,
  pivotCellPath,
  pivotMaxCell,
  type PivotAxisValue,
  type PivotRow,
  type PivotShare,
  type PivotSort,
  TOTAL_COLUMN,
} from "./pivot-model";

const SHARE_LABELS = {
  count: "Count",
  row: "Row %",
  column: "Col %",
  total: "All %",
} satisfies Record<PivotShare, string>;

const SHARE_OPTIONS = PIVOT_SHARES.map((value) => ({
  value,
  label: SHARE_LABELS[value],
}));

const UNSUPPORTED =
  "This cell cannot open as a filtered list: a dimension has no matching filter.";

interface Entry {
  row: PivotRow;
  parent: PivotRow | undefined;
}

export interface EntityPivotProps {
  metricDefinitions?: readonly {
    key: string;
    label: string;
    format: string | null;
    description: string | null;
  }[];
  /** Dimension labels in groupBy order. */
  labels: readonly string[];
  /** Lowercase record nouns, for counts and announcements. */
  recordLabel: { one: string; other: string };
  summary: GroupSummaryModel | undefined;
  isLoading: boolean;
  /** A placeholder from the previous filters or dimensions is not this scope. */
  isTransitioning: boolean;
  error: unknown;
  onRetry: () => void;
  share: PivotShare;
  onShareChange: (share: PivotShare) => void;
  /** Open the records one cell counts in the table layout. */
  onDrill: (path: readonly string[]) => void;
}

/**
 * The Pivot layout: dimension 1 as rows, dimension 2 as columns, dimension 3
 * as collapsible sub-rows, over the list's full-population group summaries.
 */
export function EntityPivot({
  labels,
  recordLabel,
  summary,
  isLoading,
  isTransitioning,
  error,
  onRetry,
  share,
  onShareChange,
  onDrill,
  metricDefinitions = [],
}: EntityPivotProps) {
  const [metricKey, setMetricKey] = useState<string | null>(null);
  const selectedMetric = metricDefinitions.find(
    (metric) => metric.key === metricKey,
  );
  const [expandColumns, setExpandColumns] = useState(false);
  const [sort, setSort] = useState<PivotSort | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const container = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const current = isTransitioning ? undefined : summary;
  const metricValues = useMemo(
    () =>
      new Map([
        ...(current?.groups.map(
          (group) =>
            [
              JSON.stringify([group.path.map((_, index) => index), group.path]),
              group.metrics?.[selectedMetric?.key ?? ""],
            ] as const,
        ) ?? []),
        ...(current?.margins.map(
          (margin) =>
            [
              JSON.stringify([margin.dimensions, margin.path]),
              margin.metrics?.[selectedMetric?.key ?? ""],
            ] as const,
        ) ?? []),
      ]),
    [current, selectedMetric?.key],
  );
  const atMetric = (dimensions: readonly number[], path: readonly string[]) =>
    metricValues.get(JSON.stringify([dimensions, path]));
  const model = useMemo(
    () =>
      current
        ? buildPivot({
            groups: current.groups,
            margins: current.margins,
            totalCount: current.totalCount,
            expandColumns: selectedMetric ? true : expandColumns,
            sort,
            metricValue: selectedMetric
              ? (dimensions, path) =>
                  metricValues.get(JSON.stringify([dimensions, path]))?.sum ??
                  null
              : undefined,
          })
        : undefined,
    [current, expandColumns, sort, selectedMetric, metricValues],
  );
  const needsDimensions = labels.length < 2;
  const state = needsDimensions
    ? ({ status: "empty" } as const)
    : visualizationState({
        data: model,
        isLoading: isLoading || isTransitioning,
        error,
        empty: model !== undefined && model.rows.length === 0,
        onRetry,
      });
  const [rowLabel = "Rows", columnLabel = "Columns", subLabel] = labels;
  const records = (count: number) =>
    `${formatCount(count)} ${count === 1 ? recordLabel.one : recordLabel.other}`;

  const columns: CrossTabColumn<PivotAxisValue>[] = model
    ? [
        ...model.columns.map((column) => ({ key: column.key, data: column })),
        ...(model.hidden.length
          ? [
              {
                key: OTHER_COLUMN,
                data: {
                  key: OTHER_COLUMN,
                  label: `+${model.hidden.length} more`,
                  total: model.hidden.reduce((sum, c) => sum + c.total, 0),
                },
              },
            ]
          : []),
      ]
    : [];
  const entries: { key: string; data: Entry }[] = model
    ? model.rows.flatMap((row) => [
        { key: JSON.stringify([row.key]), data: { row, parent: undefined } },
        ...(open.has(row.key)
          ? row.children.map((child) => ({
              key: JSON.stringify([row.key, child.key]),
              data: { row: child, parent: row },
            }))
          : []),
      ])
    : [];
  const maxCell = model ? pivotMaxCell(model) : 0;
  // Filters can shrink the matrix under the remembered cell; clamp it so one
  // cell always keeps the tab stop.
  const activeRow = Math.min(active[0], Math.max(entries.length - 1, 0));
  const activeColumn = Math.min(active[1], Math.max(columns.length - 1, 0));

  const toggleSort = (column: string) =>
    setSort((previous) =>
      previous?.column === column
        ? { column, desc: !previous.desc }
        : { column, desc: column !== "label" },
    );
  const sortMark = (column: string) => {
    const sorted =
      sort?.column === column || (sort === null && column === TOTAL_COLUMN);
    const Mark = sorted && sort?.desc === false ? CaretUpIcon : CaretDownIcon;
    return (
      <Mark
        aria-hidden
        className={cn(
          "inline size-3 shrink-0",
          sorted ? "text-foreground" : "text-muted-foreground/40",
        )}
      />
    );
  };
  /** Header buttons name their sort; `aria-sort` belongs to the header cell. */
  const sortLabel = (column: string, label: string) =>
    sort?.column === column || (sort === null && column === TOTAL_COLUMN)
      ? `Sort by ${label}, now ${sort?.desc === false ? "ascending" : "descending"}`
      : `Sort by ${label}`;

  const cellAt = (rowIndex: number, columnIndex: number) =>
    container.current?.querySelector<HTMLElement>(
      `[data-pivot-cell="${rowIndex}:${columnIndex}"]`,
    );
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const move =
      event.key === "ArrowUp"
        ? [-1, 0]
        : event.key === "ArrowDown"
          ? [1, 0]
          : event.key === "ArrowLeft"
            ? [0, -1]
            : event.key === "ArrowRight"
              ? [0, 1]
              : null;
    if (!move) return;
    const [down = 0, right = 0] = move;
    const next: [number, number] = [
      Math.min(Math.max(activeRow + down, 0), entries.length - 1),
      Math.min(Math.max(activeColumn + right, 0), columns.length - 1),
    ];
    const target = cellAt(...next);
    if (!target) return;
    event.preventDefault();
    setActive(next);
    target.focus();
  };

  const renderCell = (
    entry: { key: string; data: Entry },
    column: CrossTabColumn<PivotAxisValue>,
  ) => {
    const { row, parent } = entry.data;
    const count = row.cells.get(column.key) ?? 0;
    const rowIndex = entries.indexOf(entry);
    const columnIndex = columns.indexOf(column);
    const position = `${rowIndex}:${columnIndex}`;
    const isActive = activeRow === rowIndex && activeColumn === columnIndex;
    const other = column.key === OTHER_COLUMN;
    const path = pivotCellPath(row, column.key, parent);
    const drillable = !other && count > 0 && summary?.drillFilters(path);
    const basis = pivotBasis({
      share,
      row,
      column: column.data,
      grandTotal: model?.grandTotal ?? 0,
      maxCell,
    });
    const metric = atMetric(
      path.map((_, index) => index),
      path,
    );
    const heat =
      selectedMetric || other || count === 0 ? 0 : heatBucket(count, basis);
    const percent =
      !selectedMetric && share !== "count" && basis > 0
        ? formatPercent(count / basis)
        : null;
    const metricLabel = !selectedMetric
      ? ""
      : `; ${selectedMetric.label}: ${metric === undefined ? "unavailable" : metric.sum === null ? "unknown" : selectedMetric.format === "currency" || selectedMetric.format === "signedCurrency" ? formatCurrency(metric.sum) : formatCount(metric.sum)}${metric && metric.presentCount < metric.totalCount ? "; partial, some contributions have no amount" : ""}`;
    const label = `${row.label}${parent ? ` (${parent.label})` : ""}, ${column.data.label}: ${records(count)}${percent ? `, ${percent}` : ""}${metricLabel}`;
    const content =
      count === 0 ? (
        <span className={emptyCell}>{EMPTY_MARK}</span>
      ) : (
        <>
          {selectedMetric ? (
            <ListMetricValue
              value={metric}
              format={selectedMetric.format ?? "integer"}
            />
          ) : (
            formatCount(count)
          )}
          {percent && (
            <span
              className={cn(
                "ml-1.5 text-2xs",
                // Muted ink disappears on mid-ramp fills; follow the cell ink.
                heat >= 4
                  ? "text-background"
                  : heat >= 2
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {percent}
            </span>
          )}
        </>
      );
    const className = cn(
      cellMono,
      "block w-full",
      HEAT_CLASSES[heat],
      drillable &&
        "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-link",
      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
    );
    // Every cell is one roving tab stop; one that cannot open stays
    // focusable so its count and reason are still announced.
    const reason = count > 0 && !other && !drillable ? UNSUPPORTED : null;
    return (
      <button
        type="button"
        data-pivot-cell={position}
        tabIndex={isActive ? 0 : -1}
        aria-disabled={drillable ? undefined : true}
        aria-label={
          drillable
            ? `${label}. Open in table`
            : reason
              ? `${label}. ${reason}`
              : label
        }
        title={reason ?? undefined}
        className={className}
        onFocus={() => setActive([rowIndex, columnIndex])}
        onKeyDown={onKeyDown}
        onClick={() => {
          if (drillable) onDrill(path);
        }}
      >
        {content}
      </button>
    );
  };

  const description = model
    ? `${rowLabel} by ${columnLabel}${subLabel ? `, then ${subLabel}` : ""}: ${records(model.grandTotal)} across ${model.rows.length} ${rowLabel.toLowerCase()} values and ${model.columns.length + model.hidden.length} ${columnLabel.toLowerCase()} values.`
    : undefined;

  return (
    <div
      ref={container}
      className="flex min-w-0 flex-col gap-2 px-2 py-2 md:px-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {rowLabel} × {columnLabel}
          {subLabel ? ` › ${subLabel}` : ""}
        </span>
        {metricDefinitions.length > 0 && (
          <Picker
            label="Measure"
            options={[
              { value: "__record_count__", label: "Record count" },
              ...metricDefinitions.map((metric) => ({
                value: metric.key,
                label: metric.label,
              })),
            ]}
            value={selectedMetric?.key ?? "__record_count__"}
            onValueChange={(next) => {
              setMetricKey(next === "__record_count__" ? null : next);
              setSort(null);
            }}
          />
        )}
        {!selectedMetric && (
          <Picker
            mode="segmented"
            className="ml-auto"
            label="Cell value"
            options={SHARE_OPTIONS}
            value={share}
            onValueChange={(next) => {
              const choice = PIVOT_SHARES.find((value) => value === next);
              if (choice) onShareChange(choice);
            }}
          />
        )}
      </div>
      {selectedMetric && (
        <p className="text-xs text-muted-foreground">
          {selectedMetric.description} Amounts retain their sign; partial means
          some contributions have no amount.
        </p>
      )}
      <Visualization
        state={state}
        icon={GridNineIcon}
        message={
          needsDimensions
            ? "Group by two fields to pivot: the first makes rows, the second columns."
            : `No ${recordLabel.other} match these filters.`
        }
      >
        {model && (
          <div>
            <CrossTabTable<Entry, PivotAxisValue>
              caption={description}
              surface="background"
              bareCells
              rowHover
              layout={
                isMobile
                  ? { rowHeader: 148, column: 88, pinned: 72 }
                  : { rowHeader: 320, column: 112, pinned: 88 }
              }
              cornerLabel={
                <button
                  type="button"
                  className="inline-flex items-center gap-1"
                  aria-label={sortLabel("label", rowLabel)}
                  onClick={() => toggleSort("label")}
                >
                  {rowLabel}
                  {sortMark("label")}
                </button>
              }
              columns={columns}
              rows={entries}
              renderColumnHeader={(column) =>
                column.key === OTHER_COLUMN ? (
                  <button
                    type="button"
                    className="text-link hover:underline"
                    onClick={() => setExpandColumns(true)}
                  >
                    {column.data.label}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="inline-flex max-w-full items-center gap-1"
                    aria-label={sortLabel(column.key, column.data.label)}
                    onClick={() => toggleSort(column.key)}
                  >
                    <GroupValueLabel
                      depth={1}
                      value={column.key}
                      label={column.data.label}
                    />
                    {sortMark(column.key)}
                  </button>
                )
              }
              renderRowHeader={({ data: { row, parent } }) =>
                parent ? (
                  <span className="block pl-5 font-normal text-muted-foreground">
                    <GroupValueLabel
                      depth={2}
                      value={row.key}
                      label={row.label}
                    />
                  </span>
                ) : row.children.length > 0 ? (
                  <button
                    type="button"
                    className="inline-flex max-w-full items-center gap-1"
                    aria-expanded={open.has(row.key)}
                    onClick={() =>
                      setOpen((previous) => {
                        const next = new Set(previous);
                        if (next.has(row.key)) next.delete(row.key);
                        else next.add(row.key);
                        return next;
                      })
                    }
                  >
                    {open.has(row.key) ? (
                      <CaretDownIcon aria-hidden className="size-3" />
                    ) : (
                      <CaretRightIcon aria-hidden className="size-3" />
                    )}
                    <GroupValueLabel
                      depth={0}
                      value={row.key}
                      label={row.label}
                    />
                  </button>
                ) : (
                  <span className="block pl-4">
                    <GroupValueLabel
                      depth={0}
                      value={row.key}
                      label={row.label}
                    />
                  </span>
                )
              }
              renderCell={renderCell}
              pinned={[
                {
                  key: TOTAL_COLUMN,
                  stickyRight: "right-0",
                  label: (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      aria-label={sortLabel(TOTAL_COLUMN, "Total")}
                      onClick={() => toggleSort(TOTAL_COLUMN)}
                    >
                      Total
                      {sortMark(TOTAL_COLUMN)}
                    </button>
                  ),
                  className: totalCell,
                },
              ]}
              renderPinnedCell={({ data: { row, parent } }) => (
                <span className={cn(cellMono, "block", totalCell)}>
                  {selectedMetric ? (
                    <ListMetricValue
                      value={atMetric(
                        parent ? [0, 2] : [0],
                        parent ? [parent.key, row.key] : [row.key],
                      )}
                      format={selectedMetric.format ?? "integer"}
                    />
                  ) : (
                    formatCount(row.total)
                  )}
                </span>
              )}
              footer={[
                {
                  key: "total",
                  label: "Total",
                  cell: (key) =>
                    selectedMetric ? (
                      <ListMetricValue
                        value={atMetric([1], [key])}
                        format={selectedMetric.format ?? "integer"}
                      />
                    ) : (
                      formatCount(
                        columns.find((column) => column.key === key)?.data
                          .total ?? 0,
                      )
                    ),
                  pinnedCell: () =>
                    selectedMetric ? (
                      <ListMetricValue
                        value={current?.metrics?.[selectedMetric.key]}
                        format={selectedMetric.format ?? "integer"}
                      />
                    ) : (
                      formatCount(model.grandTotal)
                    ),
                },
              ]}
            />
          </div>
        )}
      </Visualization>
      {model?.overlapping && (
        <p className="text-xs text-muted-foreground">
          Some {recordLabel.other} hold more than one value in a dimension, so
          they appear in several cells. Totals count each{" "}
          {selectedMetric ? "contribution" : recordLabel.one} once in their
          scope.
        </p>
      )}
    </div>
  );
}
