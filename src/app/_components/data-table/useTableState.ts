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
import { type SortParams } from "~/schemas/util";

export interface TableStateOptions {
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
  getNameFilter: () => string | undefined;
  getDescriptionFilter: () => string | undefined;
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

  const getNameFilter = () => {
    return columnFilters.find((filter) => filter.id === "name")?.value as
      | string
      | undefined;
  };

  const getDescriptionFilter = () => {
    return columnFilters.find((filter) => filter.id === "foodInfo_description")
      ?.value as string | undefined;
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
    getNameFilter,
    getDescriptionFilter,
    getSortParams,
  };
}
