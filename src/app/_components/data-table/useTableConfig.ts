"use client";

import {
  type ColumnDef,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Table,
} from "@tanstack/react-table";
import { type TableStateReturn } from "./useTableState";

interface UseTableConfigOptions<TData, GLobalFilterData = unknown> {
  data: TData[];
  columns: ColumnDef<TData>[];
  tableState: TableStateReturn;
  totalCount: number;
  manualPagination?: boolean;
  manualSorting?: boolean;
  manualFiltering?: boolean;
  globalFilter?: GLobalFilterData;
  onGlobalFilterChange?: (value: GLobalFilterData) => void;
}

export function useTableConfig<TData, GLobalFilterData>({
  data,
  columns,
  tableState,
  totalCount,
  manualPagination = true,
  manualSorting = true,
  manualFiltering = true,
  globalFilter,
  onGlobalFilterChange,
}: UseTableConfigOptions<TData, GLobalFilterData>): Table<TData> {
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
