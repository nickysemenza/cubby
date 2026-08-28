import {
  type CellContext,
  type CellData,
  type Column,
  type ColumnDef,
  cellSelectionFeature,
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createExpandedRowModel,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  createTableHook,
  type FilterFn,
  metaHelper,
  type ReactTable,
  type Row,
  type RowData,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  type TableState,
  tableFeatures,
} from "@tanstack/react-table";

import type { CubbyColumnMeta, CubbyTableMeta } from "./table-meta";

/**
 * The shared feature surface for every Cubby table.
 *
 * A single superset keeps table chrome and column factories interoperable while
 * still excluding features Cubby does not use (grouping, aggregation, global
 * filtering, row pinning, faceting, and native cell spanning).
 *
 * Faceting is excluded because tables default to manualFiltering/manualPagination:
 * a client facet would count only the loaded page and read as the full set.
 * Real facet counts come from the server (see expense.facetCounts).
 */
export const cubbyTableFeatures = tableFeatures({
  cellSelectionFeature,
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnResizingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowExpandingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  expandedRowModel: createExpandedRowModel(),
  columnMeta: metaHelper<CubbyColumnMeta>(),
  tableMeta: metaHelper<CubbyTableMeta>(),
});

const cubbyTableHook = createTableHook({
  features: cubbyTableFeatures,
  columnResizeMode: "onEnd",
  enableCellRangeSelection: true,
  enableCellSelectionDrag: true,
  enableMultiCellRangeSelection: false,
  autoResetCellSelection: false,
});

/** App-bound constructor: callers supply domain data/state, never feature plumbing. */
export const useCubbyTable = cubbyTableHook.useAppTable;

/**
 * State the server-driven table owner actually renders from. Selection has
 * dedicated subscriptions below the virtualized body, so leaving row/cell
 * selection out prevents a drag from re-rendering every visible row.
 */
export function cubbyStructuralTableStateSelector(
  state: TableState<CubbyTableFeatures>,
) {
  return {
    sorting: state.sorting,
    columnFilters: state.columnFilters,
    pagination: state.pagination,
    expanded: state.expanded,
    columnOrder: state.columnOrder,
    columnPinning: state.columnPinning,
    columnVisibility: state.columnVisibility,
    columnSizing: state.columnSizing,
  };
}

type CubbyTableFeatures = typeof cubbyTableFeatures;
export type CubbyTable<TData extends RowData> = ReactTable<
  CubbyTableFeatures,
  TData
>;
export type CubbyRow<TData extends RowData> = Row<CubbyTableFeatures, TData>;
export type CubbyColumn<
  TData extends RowData,
  // biome-ignore lint/suspicious/noExplicitAny: shared table chrome accepts heterogeneous accessor values
  TValue extends CellData = any,
> = Column<CubbyTableFeatures, TData, TValue>;
export type CubbyColumnDef<
  TData extends RowData,
  // biome-ignore lint/suspicious/noExplicitAny: column arrays intentionally erase heterogeneous TValue
  TValue extends CellData = any,
> = ColumnDef<CubbyTableFeatures, TData, TValue>;
export type CubbyColumnHelper<TData extends RowData> = ReturnType<
  typeof cubbyTableHook.createAppColumnHelper<TData>
>;
export type CubbyCellContext<
  TData extends RowData,
  // biome-ignore lint/suspicious/noExplicitAny: reusable renderers accept heterogeneous cell values
  TValue extends CellData = any,
> = CellContext<CubbyTableFeatures, TData, TValue>;
export type CubbyFilterFn<TData extends RowData> = FilterFn<
  CubbyTableFeatures,
  TData
>;

export function createCubbyColumnHelper<
  TData extends RowData,
>(): CubbyColumnHelper<TData> {
  return cubbyTableHook.createAppColumnHelper<TData>();
}
