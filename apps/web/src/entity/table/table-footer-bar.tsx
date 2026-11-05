import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import type { RowData } from "@tanstack/react-table";
import { type ReactNode, useRef } from "react";

import { formatCount } from "~/lib/number-format";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { CurrencyValue } from "~/ui/values/currency-value";

import { tableMoneyTotals } from "../../ui/data-table/bulk/table-money";
import { columnLabel } from "../../ui/data-table/data-table-view-options";
import type { CubbyTable as ITable } from "../../ui/data-table/table-features";

/**
 * Empty columns leave the painted grid; this names them and brings them back.
 * Held in the footer so it stays put while a filter edit changes the rows.
 */
function EmptyColumnsMenu<TItem extends RowData>({
  table,
  emptyColumns,
  onReveal,
}: {
  table: ITable<TItem>;
  emptyColumns: readonly string[];
  onReveal: (columnIds: readonly string[]) => void;
}) {
  if (emptyColumns.length === 0) return null;
  const columns = table
    .getVisibleLeafColumns()
    .filter((column) => emptyColumns.includes(column.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 font-normal text-muted-foreground"
            aria-label={`${emptyColumns.length} empty columns hidden`}
          />
        }
      >
        +{emptyColumns.length} empty
        <CaretDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Empty in these rows</DropdownMenuLabel>
          {columns.map((column) => (
            <DropdownMenuItem
              key={column.id}
              onClick={() => onReveal([column.id])}
            >
              {columnLabel(column)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onReveal(emptyColumns)}>
          Show all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "48 products", or "20+ products" while the server has not counted them. */
function recordCount({
  known,
  loaded,
  more,
  noun,
}: {
  known: number | undefined;
  loaded: number;
  more: boolean;
  noun: { singular: string; plural: string };
}) {
  const count = known ?? loaded;
  return `${formatCount(count)}${known === undefined && more ? "+" : ""} ${count === 1 ? noun.singular : noun.plural}`;
}

/**
 * The table's one line of totals: always present on a page list, one row tall,
 * and outside the scroll pane so it never scrolls away. Money columns the page
 * does not already total sum their loaded rows and say so.
 */
export function TableFooterBar<TItem extends RowData>({
  table,
  loadedRows,
  hasMore,
  noun,
  pending,
  loading,
  failed,
  declaresTotals = false,
  children,
  emptyColumns,
  onRevealEmpty,
  pagination,
}: {
  table: ITable<TItem>;
  loadedRows: number;
  hasMore: boolean;
  noun: { singular: string; plural: string };
  /** The next query is loading; the prior values stay, dimmed. */
  pending: boolean;
  /** No rows have answered yet, so "0" would be a claim the list cannot make. */
  loading: boolean;
  /** The read failed: an empty result here is not a count of zero. */
  failed: boolean;
  /** The list prints its own totals, so column sums would only repeat them. */
  declaresTotals?: boolean;
  /** The list's own totals and status (`ListFooterContent`). */
  children?: ReactNode;
  emptyColumns: readonly string[];
  onRevealEmpty: (columnIds: readonly string[]) => void;
  pagination?: ReactNode;
}) {
  const totals = table.options.meta?.serverTotals;
  const money = tableMoneyTotals(
    table.getVisibleLeafColumns(),
    table.getFilteredRowModel().rows,
  ).flatMap((total) => {
    if (declaresTotals) return [];
    const server = totals?.sums?.[total.columnId];
    return server !== undefined
      ? [{ ...total, value: server, partial: false }]
      : [{ ...total, partial: hasMore }];
  });
  const count = recordCount({
    known: totals?.totalCount,
    loaded: loadedRows,
    more: hasMore,
    noun,
  });
  const shownCount = useRef<string | null>(null);
  if (!loading && !failed) shownCount.current = count;
  return (
    <div
      data-table-footer=""
      className="flex min-h-(--table-row-height) shrink-0 items-center gap-x-3 overflow-hidden border-t border-[var(--border)] bg-background px-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
    >
      <div
        data-table-pending={pending || loading || failed ? "" : undefined}
        className="flex min-w-0 items-center gap-x-3"
      >
        <output className="font-medium text-foreground">
          {shownCount.current ?? "…"}
        </output>
        {money.map((total) => (
          <span key={total.columnId} className="inline-flex items-center gap-1">
            <CurrencyValue
              value={total.value}
              interactive={false}
              tone={false}
            />
            {total.label}
            {total.partial ? " (loaded)" : ""}
          </span>
        ))}
      </div>
      {children}
      <div className="ml-auto flex shrink-0 items-center gap-x-3">
        <EmptyColumnsMenu
          table={table}
          emptyColumns={emptyColumns}
          onReveal={onRevealEmpty}
        />
        {pagination}
      </div>
    </div>
  );
}
