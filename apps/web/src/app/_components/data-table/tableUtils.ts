import type { SortingState } from "@tanstack/react-table";
import type { PaginationParams, SortParams } from "~/schemas/pagination";

export const buildSortParams = (
  sorting: SortingState,
  initialSort?: string,
): SortParams => {
  const sortParams: SortParams = {
    direction: sorting[0]?.desc ? "desc" : "asc",
    orderBy: sorting[0]?.id ?? initialSort ?? "createdAt",
  };
  return sortParams;
};

export const defaultPagination: PaginationParams = {
  pageIndex: 0,
  pageSize: 50,
};
export const defaultSortState = (initialSort?: string): SortingState => [
  { id: initialSort ?? "createdAt", desc: true },
];
