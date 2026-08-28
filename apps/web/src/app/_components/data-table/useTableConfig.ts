import type {
  ColumnVisibilityState,
  OnChangeFn,
  RowData,
  RowSelectionState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import {
  type CubbyColumnDef,
  type CubbyRow,
  type CubbyTable,
  cubbyStructuralTableStateSelector,
  useCubbyTable,
} from "./table-features";
import type { CubbyTableLayoutController } from "./table-layout";
import type { ServerTotals } from "./table-meta";
import type { TableStateReturn } from "./useTableState";

interface UseTableConfigOptions<TData extends RowData> {
  data: TData[];
  // Note: ColumnDef is invariant in TValue; columns often mix TValue types across accessors.
  // Using `any` here intentionally erases TValue to allow heterogeneous columns while keeping TData strict.
  // This mirrors TanStack's guidance for consumer-facing helpers that don't operate on TValue.
  // oxlint-disable-next-line typescript/no-explicit-any -- intentional
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
   * Controlled column visibility for a non-persisted table. When provided together with
   * `onColumnVisibilityChange`, the internal useState fallback is bypassed.
   */
  columnVisibility?: ColumnVisibilityState;
  onColumnVisibilityChange?: OnChangeFn<ColumnVisibilityState>;
  /** Unified persisted v9 layout owner. Preferred over visibility-only control. */
  layout?: CubbyTableLayoutController<TData>;
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
  layout,
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
  const tableColumns = layout?.columns ?? columns;

  // Memoize table options to prevent recreating on every render
  const tableOptions = useMemo(
    () => ({
      data,
      columns: tableColumns,
      onPaginationChange: setPagination,
      onSortingChange: setSorting,
      onColumnFiltersChange: setColumnFilters,
      ...(!layout ? { onColumnVisibilityChange: setColumnVisibility } : {}),
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
        defaultLayout: layout?.defaultLayout,
        scrollRestorationId: layout?.key,
      },
      ...(getRowId ? { getRowId } : {}),
      ...(enableRowSelection !== undefined ? { enableRowSelection } : {}),
      ...(onRowSelectionChange ? { onRowSelectionChange } : {}),
      enableRowRangeSelection: true,
      autoResetCellSelection: false,
      enableMultiCellRangeSelection: false,
      ...(getSubRows ? { getSubRows } : {}),
      ...(filterFromLeafRows !== undefined ? { filterFromLeafRows } : {}),
      ...(paginateExpandedRows !== undefined ? { paginateExpandedRows } : {}),
      ...(autoResetExpanded !== undefined ? { autoResetExpanded } : {}),
      ...(layout ? { atoms: layout.atoms } : {}),
      state: {
        sorting,
        columnFilters,
        ...(!layout ? { columnVisibility } : {}),
        pagination,
        ...(rowSelection ? { rowSelection } : {}),
      },
    }),
    [
      data,
      tableColumns,
      sorting,
      setSorting,
      columnFilters,
      setColumnFilters,
      columnVisibility,
      setColumnVisibility,
      layout,
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

  return useCubbyTable(
    tableOptions,
    cubbyStructuralTableStateSelector,
  ) as unknown as CubbyTable<TData>;
}
