import {
  type ColumnVisibilityState,
  type OnChangeFn,
  type RowData,
  type RowSelectionState,
  type TableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import {
  type CubbyColumnDef,
  type CubbyRow,
  type CubbyTable,
  cubbyTableFeatures,
} from "./table-features";
import type { TableStateReturn } from "./useTableState";

interface UseTableConfigOptions<TData extends RowData> {
  data: TData[];
  // Note: ColumnDef is invariant in TValue; columns often mix TValue types across accessors.
  // Using `any` here intentionally erases TValue to allow heterogeneous columns while keeping TData strict.
  // This mirrors TanStack's guidance for consumer-facing helpers that don't operate on TValue.
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  columns: CubbyColumnDef<TData, any>[];
  tableState: TableStateReturn;
  totalCount: number;
  manualPagination?: boolean;
  manualSorting?: boolean;
  manualFiltering?: boolean;
  /** Disable column sorting entirely (hides header arrows + click). Default: enabled. */
  enableSorting?: boolean;
  /** Custom row ID function for row selection */
  getRowId?: (row: TData) => string;
  /**
   * `true`/`false` for the whole table, or a predicate for a heterogeneous
   * tree where only some rows belong to the entity the bulk actions target.
   */
  enableRowSelection?: boolean | ((row: CubbyRow<TData>) => boolean);
  /** Current row selection state */
  rowSelection?: RowSelectionState;
  /** Callback when row selection changes */
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  /** Columns hidden by default (user can toggle via View menu) */
  initialColumnVisibility?: Record<string, boolean>;
  /**
   * Controlled column visibility (e.g. the persisted per-entity store from
   * `useTableColumnVisibility`). When provided together with
   * `onColumnVisibilityChange`, the internal useState fallback is bypassed.
   */
  columnVisibility?: ColumnVisibilityState;
  onColumnVisibilityChange?: OnChangeFn<ColumnVisibilityState>;
  /**
   * Server-computed totals over the FULL filtered set, surfaced to footer
   * renderers via table meta — client rows only cover loaded pages.
   */
  serverTotals?: ServerTotals;
  /**
   * Changes when cells read render-time state that does not live on
   * `row.original` (for example asynchronously fetched relation previews).
   * RTable forwards it to its memoized desktop and mobile row renderers.
   */
  rowContentVersion?: unknown;
  /**
   * Opt-in expandable tree support. Return a row's children to render nested
   * sub-rows. The shared v9 feature bundle includes the expanded row model;
   * without `getSubRows`, no table data is expandable.
   */
  getSubRows?: (row: TData) => TData[] | undefined;
  /**
   * Keep a parent visible when a descendant leaf matches the active filter.
   * TanStack default is `true`; only forwarded when explicitly set.
   */
  filterFromLeafRows?: boolean;
  /** Paginate expanded sub-rows alongside parents. TanStack default `true`. */
  paginateExpandedRows?: boolean;
  /** Reset expanded state when data/filters change. TanStack default `true`. */
  autoResetExpanded?: boolean;
}

interface ServerTotals {
  /** Total rows matching the current filters (not just loaded pages). */
  totalCount: number;
  /** Column sums over the full filtered set, keyed by column id. */
  sums?: Record<string, number>;
}

declare module "@tanstack/react-table" {
  // TData is required to match the library's TableMeta signature for the
  // module augmentation to merge; it's structurally unused here.
  interface TableMeta<TFeatures extends TableFeatures, TData extends RowData> {
    serverTotals?: ServerTotals;
    /**
     * How many URL-only scopes (see `urlOnly` in `entities/filters`) are
     * narrowing the rows. They can't live in `columnFilters` — TanStack
     * resolves every entry there to a column — but the empty state still has
     * to know they're on, or a scoped deep link that matches nothing reads as
     * "you have no expenses at all". See `isNarrowed`.
     */
    urlScopeCount?: number;
    /** See `UseTableConfigOptions.rowContentVersion`. */
    rowContentVersion?: unknown;
    _tData?: TData;
  }
}

export function useTableConfig<TData extends RowData>({
  data,
  columns,
  tableState,
  totalCount,
  manualPagination = true,
  manualSorting = true,
  manualFiltering = true,
  enableSorting,
  getRowId,
  enableRowSelection,
  rowSelection,
  onRowSelectionChange,
  initialColumnVisibility,
  columnVisibility: controlledVisibility,
  onColumnVisibilityChange: controlledOnVisibilityChange,
  serverTotals,
  rowContentVersion,
  getSubRows,
  filterFromLeafRows,
  paginateExpandedRows,
  autoResetExpanded,
}: UseTableConfigOptions<TData>): CubbyTable<TData> {
  const {
    sorting,
    setSorting,
    columnFilters,
    allFilters,
    setColumnFilters,
    pagination,
    setPagination,
  } = tableState;

  // `allFilters` is `columnFilters` plus the URL-only scopes; only the latter
  // go into the table (every entry there must resolve to a column), so the
  // difference is what the empty state would otherwise be blind to.
  const urlScopeCount = allFilters.length - columnFilters.length;

  const [internalVisibility, setInternalVisibility] = useState<
    Record<string, boolean>
  >(initialColumnVisibility ?? {});
  const columnVisibility = controlledVisibility ?? internalVisibility;
  const setColumnVisibility =
    controlledOnVisibilityChange ?? setInternalVisibility;

  // Memoize table options to prevent recreating on every render
  const tableOptions = useMemo(
    () => ({
      features: cubbyTableFeatures,
      data,
      columns,
      onPaginationChange: setPagination,
      onSortingChange: setSorting,
      onColumnFiltersChange: setColumnFilters,
      onColumnVisibilityChange: setColumnVisibility,
      manualSorting,
      manualFiltering,
      manualPagination,
      // Multi-sort: shift-click stacks columns (isMultiSortEvent default).
      // sortDescFirst:false preserves the asc-first click cycle on numeric
      // columns; enableSortingRemoval gives asc → desc → clear (cleared falls
      // back to the entity default server-side via buildSortsParams).
      enableMultiSort: true,
      maxMultiSortColCount: 3,
      enableSortingRemoval: true,
      sortDescFirst: false,
      ...(enableSorting !== undefined ? { enableSorting } : {}),
      rowCount: totalCount,
      meta: {
        ...(serverTotals ? { serverTotals } : {}),
        ...(urlScopeCount > 0 ? { urlScopeCount } : {}),
        ...(rowContentVersion !== undefined ? { rowContentVersion } : {}),
      },
      // Row selection
      ...(getRowId ? { getRowId } : {}),
      ...(enableRowSelection !== undefined ? { enableRowSelection } : {}),
      ...(onRowSelectionChange ? { onRowSelectionChange } : {}),
      // Cubby owns Shift-range selection so TanStack's native range behavior
      // cannot compete with the custom selectable-row rules below.
      enableRowRangeSelection: false,
      ...(getSubRows ? { getSubRows } : {}),
      ...(filterFromLeafRows !== undefined ? { filterFromLeafRows } : {}),
      ...(paginateExpandedRows !== undefined ? { paginateExpandedRows } : {}),
      ...(autoResetExpanded !== undefined ? { autoResetExpanded } : {}),
      state: {
        sorting,
        columnFilters,
        columnVisibility,
        pagination,
        ...(rowSelection ? { rowSelection } : {}),
      },
    }),
    [
      data,
      columns,
      sorting,
      setSorting,
      columnFilters,
      setColumnFilters,
      columnVisibility,
      setColumnVisibility,
      pagination,
      setPagination,
      manualSorting,
      manualFiltering,
      manualPagination,
      enableSorting,
      totalCount,
      serverTotals,
      urlScopeCount,
      rowContentVersion,
      getRowId,
      enableRowSelection,
      rowSelection,
      onRowSelectionChange,
      getSubRows,
      filterFromLeafRows,
      paginateExpandedRows,
      autoResetExpanded,
    ],
  );

  return useTable(tableOptions);
}
