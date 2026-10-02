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
  TData,
  ReturnType<typeof cubbyStructuralTableStateSelector>
>;
export type CubbyRow<TData extends RowData> = Row<CubbyTableFeatures, TData>;
export type CubbyColumn<
  TData extends RowData,
  TValue extends CellData = CellData,
> = Column<CubbyTableFeatures, TData, TValue>;
export type CubbyColumnDef<
  TData extends RowData,
  TValue extends CellData = CellData,
> = ColumnDef<CubbyTableFeatures, TData, TValue>;
export type CubbyColumnHelper<TData extends RowData> = ReturnType<
  typeof cubbyTableHook.createAppColumnHelper<TData>
>;
export type CubbyCellContext<
  TData extends RowData,
  TValue extends CellData = CellData,
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

/** A visitor preserves one column's captured accessor value type. */
interface CubbyColumnEntry<TData extends RowData> {
  visit<TResult>(
    visitor: <TValue extends CellData>(
      definition: CubbyColumnDef<TData, TValue>,
    ) => TResult,
  ): TResult;
}

class CapturedCubbyColumn<
  TData extends RowData,
  TValue extends CellData,
> implements CubbyColumnEntry<TData> {
  constructor(private readonly definition: CubbyColumnDef<TData, TValue>) {}

  visit<TResult>(
    visitor: <TValueForVisitor extends CellData>(
      definition: CubbyColumnDef<TData, TValueForVisitor>,
    ) => TResult,
  ): TResult {
    return visitor(this.definition);
  }
}

/**
 * Heterogeneous column collection. Each `add` call captures its own `TValue`;
 * consumers can inspect definitions only through a generic visitor instead of
 * widening every accessor to an uncorrelated array element type.
 */
export interface CubbyColumnCollection<TData extends RowData> {
  readonly length: number;
  visit<TResult>(
    visitor: <TValue extends CellData>(
      definition: CubbyColumnDef<TData, TValue>,
    ) => TResult,
  ): TResult[];
  filter(
    predicate: <TValue extends CellData>(
      definition: CubbyColumnDef<TData, TValue>,
    ) => boolean,
  ): CubbyColumnCollection<TData>;
}

export function createCubbyColumnCollection<TData extends RowData>(
  build: (
    add: <TValue extends CellData>(
      definition: CubbyColumnDef<TData, TValue>,
    ) => void,
  ) => void,
): CubbyColumnCollection<TData> {
  const entries: CubbyColumnEntry<TData>[] = [];
  build((definition) => {
    entries.push(new CapturedCubbyColumn(definition));
  });
  return {
    length: entries.length,
    visit: (visitor) => entries.map((entry) => entry.visit(visitor)),
    filter: (predicate) =>
      createCubbyColumnCollection<TData>((add) => {
        for (const entry of entries) {
          entry.visit((definition) => {
            if (predicate(definition)) add(definition);
          });
        }
      }),
  };
}

/**
 * The sole TanStack interop boundary for heterogeneous definitions.
 *
 * SAFETY: a collection only admits a `CubbyColumnDef<TData, TValue>` through
 * its generic collector. TanStack stores every definition with that captured
 * TValue but represents the outer list as one array, an existential type that
 * TypeScript cannot express. No caller may inspect TValue after this point.
 */
export function materializeCubbyColumns<TData extends RowData>(
  columns: CubbyColumnCollection<TData>,
): ColumnDef<CubbyTableFeatures, TData, CellData>[] {
  return columns.visit(
    (definition) =>
      // SAFETY: the generic collector captured this definition's TValue; TanStack
      // consumes the outer array opaquely and never exposes a cross-column TValue.
      definition as ColumnDef<CubbyTableFeatures, TData, CellData>,
  );
}
