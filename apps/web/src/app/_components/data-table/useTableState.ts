import type { SortParams } from "@cubby/schemas/pagination";
import type {
  ColumnFiltersState,
  PaginationState,
  SortingState,
} from "@tanstack/react-table";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  buildSortParams,
  defaultPagination,
  defaultSortState,
} from "./tableUtils";

interface TableStateOptions {
  initialSort?: string;
  initialFilter?: ColumnFiltersState;
  initialPagination?: PaginationState;
}

export interface TableStateReturn {
  sorting: SortingState;
  setSorting: (
    value: SortingState | ((old: SortingState) => SortingState),
  ) => void;
  columnFilters: ColumnFiltersState;
  setColumnFilters: (
    value:
      | ColumnFiltersState
      | ((old: ColumnFiltersState) => ColumnFiltersState),
  ) => void;
  pagination: PaginationState;
  setPagination: (
    value: PaginationState | ((old: PaginationState) => PaginationState),
  ) => void;
  getColumnFilter: (columnId: string) => string | undefined;
  getSortParams: () => SortParams;
}

export function useTableState(
  options: TableStateOptions = {},
): TableStateReturn {
  const {
    initialSort = "createdAt",
    initialFilter = [],
    initialPagination = defaultPagination,
  } = options;

  const [, startTransition] = useTransition();

  const [sorting, setSortingRaw] = useState<SortingState>(
    defaultSortState(initialSort),
  );
  const [columnFilters, setColumnFiltersRaw] =
    useState<ColumnFiltersState>(initialFilter);
  const [pagination, setPaginationRaw] =
    useState<PaginationState>(initialPagination);

  // Wrap state setters in startTransition to prevent UI freezing
  const setSorting = useCallback(
    (value: SortingState | ((old: SortingState) => SortingState)) =>
      startTransition(() =>
        setSortingRaw(typeof value === "function" ? value : () => value),
      ),
    [],
  );
  const setColumnFilters = useCallback(
    (
      value:
        | ColumnFiltersState
        | ((old: ColumnFiltersState) => ColumnFiltersState),
    ) =>
      startTransition(() =>
        setColumnFiltersRaw(typeof value === "function" ? value : () => value),
      ),
    [],
  );
  const setPagination = useCallback(
    (value: PaginationState | ((old: PaginationState) => PaginationState)) =>
      startTransition(() =>
        setPaginationRaw(typeof value === "function" ? value : () => value),
      ),
    [],
  );

  // Memoize getColumnFilter to prevent recreating on every render - CRITICAL
  const getColumnFilter = useCallback(
    (columnId: string) => {
      return columnFilters.find((filter) => filter.id === columnId)?.value as
        | string
        | undefined;
    },
    [columnFilters],
  );

  // Memoize getSortParams to prevent recreating on every render - CRITICAL
  const getSortParams = useCallback(() => {
    return buildSortParams(sorting, initialSort);
  }, [sorting, initialSort]);

  // Memoize the entire return object to prevent recreating on every render - CRITICAL
  return useMemo(
    () => ({
      sorting,
      setSorting,
      columnFilters,
      setColumnFilters,
      pagination,
      setPagination,
      getColumnFilter,
      getSortParams,
    }),
    [
      sorting,
      setSorting,
      columnFilters,
      setColumnFilters,
      pagination,
      setPagination,
      getColumnFilter,
      getSortParams,
    ],
  );
}
