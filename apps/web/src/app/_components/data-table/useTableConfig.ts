import {
  type ColumnDef,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type OnChangeFn,
  type RowSelectionState,
  type Table,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import type { TableStateReturn } from "./useTableState";

interface UseTableConfigOptions<TData, GlobalFilterData = unknown> {
  data: TData[];
  // Note: ColumnDef is invariant in TValue; columns often mix TValue types across accessors.
  // Using `any` here intentionally erases TValue to allow heterogeneous columns while keeping TData strict.
  // This mirrors TanStack's guidance for consumer-facing helpers that don't operate on TValue.
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  columns: ColumnDef<TData, any>[];
  tableState: TableStateReturn;
  totalCount: number;
  manualPagination?: boolean;
  manualSorting?: boolean;
  manualFiltering?: boolean;
  globalFilter?: GlobalFilterData;
  onGlobalFilterChange?: (value: GlobalFilterData) => void;
  /** Custom row ID function for row selection */
  getRowId?: (row: TData) => string;
  /** Enable row selection */
  enableRowSelection?: boolean;
  /** Current row selection state */
  rowSelection?: RowSelectionState;
  /** Callback when row selection changes */
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  /** Columns hidden by default (user can toggle via View menu) */
  initialColumnVisibility?: Record<string, boolean>;
}

export function useTableConfig<TData, GlobalFilterData>({
  data,
  columns,
  tableState,
  totalCount,
  manualPagination = true,
  manualSorting = true,
  manualFiltering = true,
  globalFilter,
  onGlobalFilterChange,
  getRowId,
  enableRowSelection,
  rowSelection,
  onRowSelectionChange,
  initialColumnVisibility,
}: UseTableConfigOptions<TData, GlobalFilterData>): Table<TData> {
  const {
    sorting,
    setSorting,
    columnFilters,
    setColumnFilters,
    pagination,
    setPagination,
  } = tableState;

  const [columnVisibility, setColumnVisibility] = useState<
    Record<string, boolean>
  >(initialColumnVisibility ?? {});

  // Memoize row models - these are stable functions
  const coreRowModel = useMemo(() => getCoreRowModel<TData>(), []);
  const filteredRowModel = useMemo(() => getFilteredRowModel<TData>(), []);
  const facetedRowModel = useMemo(() => getFacetedRowModel<TData>(), []);
  const facetedUniqueValues = useMemo(
    () => getFacetedUniqueValues<TData>(),
    [],
  );
  const paginationRowModel = useMemo(() => getPaginationRowModel<TData>(), []);
  const sortedRowModel = useMemo(() => getSortedRowModel<TData>(), []);

  // Memoize table options to prevent recreating on every render
  const tableOptions = useMemo(
    () => ({
      data,
      columns,
      getCoreRowModel: coreRowModel,
      getFilteredRowModel: filteredRowModel,
      getFacetedRowModel: facetedRowModel,
      getFacetedUniqueValues: facetedUniqueValues,
      getPaginationRowModel: paginationRowModel,
      getSortedRowModel: sortedRowModel,
      onPaginationChange: setPagination,
      onSortingChange: setSorting,
      onColumnFiltersChange: setColumnFilters,
      onColumnVisibilityChange: setColumnVisibility,
      manualSorting,
      manualFiltering,
      manualPagination,
      rowCount: totalCount,
      // Row selection
      ...(getRowId ? { getRowId } : {}),
      ...(enableRowSelection !== undefined ? { enableRowSelection } : {}),
      ...(onRowSelectionChange ? { onRowSelectionChange } : {}),
      state: {
        sorting,
        columnFilters,
        columnVisibility,
        pagination,
        ...(globalFilter ? { globalFilter } : {}),
        ...(rowSelection ? { rowSelection } : {}),
      },
      ...(onGlobalFilterChange ? { onGlobalFilterChange } : {}),
    }),
    [
      data,
      columns,
      coreRowModel,
      filteredRowModel,
      facetedRowModel,
      facetedUniqueValues,
      paginationRowModel,
      sortedRowModel,
      sorting,
      setSorting,
      columnFilters,
      setColumnFilters,
      columnVisibility,
      pagination,
      setPagination,
      manualSorting,
      manualFiltering,
      manualPagination,
      totalCount,
      getRowId,
      enableRowSelection,
      rowSelection,
      onRowSelectionChange,
      globalFilter,
      onGlobalFilterChange,
    ],
  );

  return useReactTable(tableOptions);
}
