"use client";

import { useState } from "react";
import {
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@tanstack/react-table";
import {
  defaultPagination,
  defaultSortState,
  buildSortParams,
} from "./tableUtils";
import { type SortParams } from "~/schemas/pagination";

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

  const [sorting, setSorting] = useState<SortingState>(
    defaultSortState(initialSort),
  );
  const [columnFilters, setColumnFilters] =
    useState<ColumnFiltersState>(initialFilter);
  const [pagination, setPagination] =
    useState<PaginationState>(initialPagination);

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
