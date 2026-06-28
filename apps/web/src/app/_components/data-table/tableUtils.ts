import {
  MAX_PAGE_SIZE,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { SortingState } from "@tanstack/react-table";

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
  pageSize: Math.min(100, MAX_PAGE_SIZE),
};
export const defaultSortState = (initialSort?: string): SortingState => [
  { id: initialSort ?? "createdAt", desc: true },
];
