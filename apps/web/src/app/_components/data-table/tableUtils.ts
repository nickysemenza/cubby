import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
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
  // Lists render through a window virtualizer, so a large default page size
  // shows "everything" in one natural-scrolling page without a DOM blowup.
  pageSize: 1000,
};
export const defaultSortState = (initialSort?: string): SortingState => [
  { id: initialSort ?? "createdAt", desc: true },
];
