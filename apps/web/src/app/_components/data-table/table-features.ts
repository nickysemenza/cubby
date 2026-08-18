import {
  type CellContext,
  type CellData,
  type Column,
  type ColumnDef,
  type ColumnHelper,
  columnFacetingFeature,
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createExpandedRowModel,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  type FilterFn,
  type ReactTable,
  type Row,
  type RowData,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * The shared feature surface for every Cubby table.
 *
 * A single superset keeps table chrome and column factories interoperable while
 * still excluding TanStack features Cubby does not use (grouping, aggregation,
 * pinning, native cell selection, and native column resizing).
 */
export const cubbyTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnFacetingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowExpandingFeature,
  filteredRowModel: createFilteredRowModel(),
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  expandedRowModel: createExpandedRowModel(),
});

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
export type CubbyColumnHelper<TData extends RowData> = ColumnHelper<
  CubbyTableFeatures,
  TData
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
  return createColumnHelper<CubbyTableFeatures, TData>();
}
