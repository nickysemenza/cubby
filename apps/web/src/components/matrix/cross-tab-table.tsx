import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { type CrossTabColumn, groupColumnRuns } from "./group-columns";
import {
  bodyRule,
  cellMono,
  EMPTY_MARK,
  emptyCell,
  footRule,
  headRule,
  stickyRowHeaderCard,
  stickyRowHeaderPage,
} from "./matrix-chrome";

// The layout shell shared by the app's cross-tabs: scroll container, table,
// head (corner + optional spanning group row + column headers), body with a
// sticky row header, optional pinned trailing columns, and a footer.
//
// It owns layout and nothing else — no pivoting, sorting, aggregation, heat or
// interactivity. That line is what keeps it from drifting into "any table":
// the matrices whose *behavior* is the point (tool-matrix-page's optimistic
// cell writes, RecipeCompareGrid's stat glyphs) deliberately don't use it and
// take only the chrome constants instead.

interface CrossTabEntry<R> {
  key: string;
  data: R;
}

/** A trailing rollup column (Total, or Need/Have/Short). */
interface CrossTabPinned {
  key: string;
  label: ReactNode;
  /**
   * Tailwind right-offset (`"right-0"`, `"right-20"`) to pin this column while
   * the body columns scroll under it. Offsets only line up under a fixed
   * layout, so a pinned column requires `tableWidth` — see the prop's note.
   */
  stickyRight?: string;
  className?: string;
}

export interface CrossTabFooterRow {
  key: string;
  label: ReactNode;
  labelTitle?: string;
  cell: (columnKey: string, index: number) => ReactNode;
  pinnedCell?: (pinnedKey: string) => ReactNode;
  /** Applied to this row's body *and* pinned cells (a totals row is one tone). */
  cellClassName?: string;
  /** The first footer row carries the closing rule; extras render plain. */
  emphasis?: "rule" | "plain";
}

export interface CrossTabTableProps<R, C> {
  cornerLabel: ReactNode;
  columns: readonly CrossTabColumn<C>[];
  rows: readonly CrossTabEntry<R>[];

  renderColumnHeader: (column: CrossTabColumn<C>) => ReactNode;
  /** Required to render the spanning row; without it groupKeys are ignored. */
  renderGroupHeader?: (
    groupKey: string,
    columns: CrossTabColumn<C>[],
  ) => ReactNode;
  renderRowHeader: (row: CrossTabEntry<R>) => ReactNode;
  /** Return `null` for "this row has no value here" — renders the empty mark. */
  renderCell: (row: CrossTabEntry<R>, column: CrossTabColumn<C>) => ReactNode;
  cellClassName?: (
    row: CrossTabEntry<R>,
    column: CrossTabColumn<C>,
  ) => string | undefined;
  cellTitle?: (
    row: CrossTabEntry<R>,
    column: CrossTabColumn<C>,
  ) => string | undefined;

  pinned?: readonly CrossTabPinned[];
  renderPinnedCell?: (
    row: CrossTabEntry<R>,
    pinned: CrossTabPinned,
  ) => ReactNode;
  footer?: readonly CrossTabFooterRow[];

  rowClassName?: (row: CrossTabEntry<R>) => string | undefined;
  /**
   * Highlight the hovered row. Worth it on a wide grid where the eye has to
   * travel from the sticky name to a far-right column; noise on a narrow one,
   * so it's opt-in rather than a default the print/export sheets inherit.
   */
  rowHover?: boolean;
  /**
   * Drop cell padding so the caller can render a full-bleed interactive child
   * (a button) that carries the padding itself and fills the whole hit area.
   */
  bareCells?: boolean;
  /** Which surface the sticky panes sit on. Must match the actual background. */
  surface?: "card" | "background";
  /**
   * Explicit table width in px, switching the table to a fixed layout.
   * Required whenever any `pinned[].stickyRight` is set: `right-*` offsets are
   * absolute, so they only align if the pinned columns have known widths, and
   * an auto layout won't guarantee that.
   */
  tableWidth?: number;
  /** Sticky header offset, e.g. `"top-[51px]"` to sit under the app nav. */
  stickyHeaderTop?: string;
  caption?: ReactNode;
  className?: string;
}

export function CrossTabTable<R, C>({
  cornerLabel,
  columns,
  rows,
  renderColumnHeader,
  renderGroupHeader,
  renderRowHeader,
  renderCell,
  cellClassName,
  cellTitle,
  pinned,
  renderPinnedCell,
  footer,
  rowClassName,
  rowHover = false,
  bareCells = false,
  surface = "card",
  tableWidth,
  stickyHeaderTop,
  caption,
  className,
}: CrossTabTableProps<R, C>) {
  const sticky = surface === "card" ? stickyRowHeaderCard : stickyRowHeaderPage;
  const surfaceBg = surface === "card" ? "bg-card" : "bg-background";
  const runs = renderGroupHeader ? groupColumnRuns(columns) : [];
  const pinnedColumns = pinned ?? [];

  return (
    <div className="overflow-x-auto">
      <table
        className={cn(
          "border-collapse text-left",
          tableWidth == null ? "w-full" : "table-fixed",
          className,
        )}
        style={tableWidth == null ? undefined : { width: tableWidth }}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead
          className={cn(
            stickyHeaderTop && ["sticky z-30", stickyHeaderTop, surfaceBg],
          )}
        >
          {renderGroupHeader && (
            <tr className="eyebrow">
              {/* Corner outranks both sticky axes where they cross. */}
              <th className={cn(sticky, "z-20 px-2 py-1")} />
              {runs.map((run) => (
                <th
                  key={run.columns[0]?.key ?? run.groupKey}
                  colSpan={run.columns.length}
                  className="border-border border-l px-2 py-1 text-left font-medium"
                >
                  {run.groupKey === undefined
                    ? null
                    : renderGroupHeader(run.groupKey, run.columns)}
                </th>
              ))}
              {pinnedColumns.map((p) => (
                <th key={p.key} />
              ))}
            </tr>
          )}
          <tr className={headRule}>
            <th className={cn(sticky, "z-20 px-2 py-2 font-medium")}>
              {cornerLabel}
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                className="px-2 py-2 text-right align-bottom font-medium"
              >
                {renderColumnHeader(column)}
              </th>
            ))}
            {pinnedColumns.map((p) => (
              <th
                key={p.key}
                className={cn(
                  "px-2 py-2 text-right font-medium",
                  p.stickyRight && ["sticky z-20", p.stickyRight, surfaceBg],
                  p.className,
                )}
              >
                {p.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={cn(
                rowHover && "group/row hover:bg-muted/20",
                bodyRule,
                rowClassName?.(row),
              )}
            >
              {/* Sticky cells are opaque, so they can't inherit the row's
                  hover background — they have to repaint it themselves. */}
              <th
                scope="row"
                className={cn(
                  sticky,
                  "px-2 py-2 text-left font-medium text-sm",
                  rowHover && "group-hover/row:bg-muted",
                )}
              >
                {renderRowHeader(row)}
              </th>
              {columns.map((column) => {
                const content = renderCell(row, column);
                return (
                  <td
                    key={column.key}
                    // Under `bareCells` the title belongs on the caller's own
                    // child, alongside the classes — putting one here too would
                    // nest two tooltips over the same pixels.
                    title={bareCells ? undefined : cellTitle?.(row, column)}
                    className={
                      bareCells
                        ? "p-0"
                        : cn(
                            cellMono,
                            content == null && emptyCell,
                            cellClassName?.(row, column),
                          )
                    }
                  >
                    {content ?? EMPTY_MARK}
                  </td>
                );
              })}
              {pinnedColumns.map((p) => (
                <td
                  key={p.key}
                  className={cn(
                    // Under `bareCells` the caller's own child carries the
                    // padding, here too — a pinned cell that kept its padding
                    // would leave the trailing button un-clickable at its edges.
                    bareCells ? "p-0" : cn(cellMono, p.className),
                    p.stickyRight && ["sticky z-10", p.stickyRight, surfaceBg],
                    p.stickyRight && rowHover && "group-hover/row:bg-muted",
                  )}
                >
                  {renderPinnedCell?.(row, p)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && footer.length > 0 && (
          <tfoot>
            {footer.map((f) => (
              <tr
                key={f.key}
                className={f.emphasis === "plain" ? "eyebrow" : footRule}
              >
                <th
                  scope="row"
                  className={cn(sticky, "px-2 py-2 text-left font-medium")}
                  title={f.labelTitle}
                >
                  {f.label}
                </th>
                {columns.map((column, index) => (
                  <td
                    key={column.key}
                    className={cn(cellMono, f.cellClassName)}
                  >
                    {f.cell(column.key, index)}
                  </td>
                ))}
                {pinnedColumns.map((p) => (
                  <td
                    key={p.key}
                    className={cn(
                      cellMono,
                      f.cellClassName,
                      p.stickyRight && [
                        "sticky z-10",
                        p.stickyRight,
                        surfaceBg,
                      ],
                    )}
                  >
                    {f.pinnedCell?.(p.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tfoot>
        )}
      </table>
    </div>
  );
}
