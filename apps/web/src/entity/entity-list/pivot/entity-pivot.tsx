import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { GridNineIcon } from "@phosphor-icons/react/dist/csr/GridNine";
import { type KeyboardEvent, useMemo, useState } from "react";

import type { GroupSummaryModel } from "~/entity/entity-list/group-drill-down";
import { formatCount, formatPercent } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
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
}: EntityPivotProps) {
  const [expandColumns, setExpandColumns] = useState(false);
  const [sort, setSort] = useState<PivotSort | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const current = isTransitioning ? undefined : summary;
  const model = useMemo(
    () =>
      current
        ? buildPivot({
            groups: current.groups,
            margins: current.margins,
            totalCount: current.totalCount,
            expandColumns,
            sort,
          })
        : undefined,
    [current, expandColumns, sort],
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
          "inline size-3",
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
    document.querySelector<HTMLElement>(
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
    const [rowIndex, columnIndex] = active;
    const [down = 0, right = 0] = move;
    const next: [number, number] = [
      Math.min(Math.max(rowIndex + down, 0), entries.length - 1),
      Math.min(Math.max(columnIndex + right, 0), columns.length - 1),
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
    const isActive = active[0] === rowIndex && active[1] === columnIndex;
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
    const heat = other || count === 0 ? 0 : heatBucket(count, basis);
    const percent =
      share !== "count" && basis > 0 ? formatPercent(count / basis) : null;
    const label = `${row.label}${parent ? ` (${parent.label})` : ""}, ${column.data.label}: ${records(count)}${percent ? `, ${percent}` : ""}`;
    const content =
      count === 0 ? (
        <span className={emptyCell}>{EMPTY_MARK}</span>
      ) : (
        <>
          {formatCount(count)}
          {percent && (
            <span
              className={cn(
                "ml-1.5 text-2xs",
                // Muted ink disappears on mid-ramp fills; follow the cell ink.
                heat >= 4
                  ? "text-background/80"
                  : heat >= 2
                    ? "text-foreground/75"
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
    <div className="min-w-0 space-y-2 px-2 py-2 md:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {rowLabel} × {columnLabel}
          {subLabel ? ` › ${subLabel}` : ""}
        </span>
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
      </div>
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
                    className="inline-flex items-center gap-1"
                    aria-label={sortLabel(column.key, column.data.label)}
                    onClick={() => toggleSort(column.key)}
                  >
                    {column.data.label}
                    {sortMark(column.key)}
                  </button>
                )
              }
              renderRowHeader={({ data: { row, parent } }) =>
                parent ? (
                  <span className="block pl-5 font-normal text-muted-foreground">
                    {row.label}
                  </span>
                ) : row.children.length > 0 ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
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
                    {row.label}
                  </button>
                ) : (
                  <span className="block pl-4">{row.label}</span>
                )
              }
              renderCell={renderCell}
              pinned={[
                {
                  key: TOTAL_COLUMN,
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
              renderPinnedCell={({ data: { row } }) => (
                <span className={cn(cellMono, "block", totalCell)}>
                  {formatCount(row.total)}
                </span>
              )}
              footer={[
                {
                  key: "total",
                  label: "Total",
                  cell: (key) =>
                    formatCount(
                      columns.find((column) => column.key === key)?.data
                        .total ?? 0,
                    ),
                  pinnedCell: () => formatCount(model.grandTotal),
                },
              ]}
            />
          </div>
        )}
      </Visualization>
      {model?.overlapping && (
        <p className="text-xs text-muted-foreground">
          Some {recordLabel.other} hold more than one value in a dimension, so
          they appear in several cells. Totals count each record once.
        </p>
      )}
    </div>
  );
}
