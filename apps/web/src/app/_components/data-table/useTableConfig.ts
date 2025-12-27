import {
  type ColumnDef,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type Table,
  useReactTable,
} from "@tanstack/react-table";
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
}: UseTableConfigOptions<TData, GlobalFilterData>): Table<TData> {
  const {
    sorting,
    setSorting,
    columnFilters,
    setColumnFilters,
    pagination,
    setPagination,
  } = tableState;

  return useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onPaginationChange: (updater) =>
      setPagination(
        typeof updater === "function" ? updater(pagination) : updater,
      ),
    onSortingChange: (updater) =>
      setSorting(typeof updater === "function" ? updater(sorting) : updater),
    onColumnFiltersChange: (updater) =>
      setColumnFilters(
        typeof updater === "function" ? updater(columnFilters) : updater,
      ),
    manualSorting,
    manualFiltering,
    manualPagination,
    rowCount: totalCount,
    state: {
      sorting,
      columnFilters,
      pagination,
      ...(globalFilter ? { globalFilter } : {}),
    },
    ...(onGlobalFilterChange ? { onGlobalFilterChange } : {}),
  });
}
