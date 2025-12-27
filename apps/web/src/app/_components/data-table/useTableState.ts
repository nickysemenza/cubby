"use client";

import type {
  ColumnFiltersState,
  PaginationState,
  SortingState,
} from "@tanstack/react-table";
import { useCallback, useState, useTransition } from "react";
import type { SortParams } from "~/schemas/pagination";
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
  setSorting: (value: SortingState) => void;
  columnFilters: ColumnFiltersState;
  setColumnFilters: (value: ColumnFiltersState) => void;
  pagination: PaginationState;
  setPagination: (value: PaginationState) => void;
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
    (value: SortingState) => startTransition(() => setSortingRaw(value)),
    [],
  );
  const setColumnFilters = useCallback(
    (value: ColumnFiltersState) =>
      startTransition(() => setColumnFiltersRaw(value)),
    [],
  );
  const setPagination = useCallback(
    (value: PaginationState) => startTransition(() => setPaginationRaw(value)),
    [],
  );

  const getColumnFilter = (columnId: string) => {
    return columnFilters.find((filter) => filter.id === columnId)?.value as
      | string
      | undefined;
  };

  const getSortParams = () => {
    return buildSortParams(sorting, initialSort);
  };

  return {
    sorting,
    setSorting,
    columnFilters,
    setColumnFilters,
    pagination,
    setPagination,
    getColumnFilter,
    getSortParams,
  };
}
