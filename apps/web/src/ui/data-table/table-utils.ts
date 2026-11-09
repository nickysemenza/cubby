import {
  MAX_PAGE_SIZE,
  MAX_SORTS,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { SortingState } from "@tanstack/react-table";

/**
 * Primary sort only — for single-sort consumers (the remote USDA list API).
 * List pages use `buildSortsParams` (the full shift-click stack).
 */
export const buildSortParams = (
  sorting: SortingState,
  initialSort: string,
): SortParams => {
  const sortParams: SortParams = {
    direction: sorting[0]?.desc ? "desc" : "asc",
    orderBy: sorting[0]?.id ?? initialSort,
  };
  return sortParams;
};

/**
 * Full sort stack for the list operation input. A cleared sort (a third click
 * with enableSortingRemoval) falls back to the table's opening sort.
 */
export const buildSortsParams = (
  sorting: SortingState,
  initialSort: string,
  initialSortDesc: boolean,
): SortParams[] => {
  if (sorting.length === 0) {
    return [
      {
        orderBy: initialSort,
        direction: initialSortDesc ? "desc" : "asc",
      },
    ];
  }
  return sorting.slice(0, MAX_SORTS).map((s) => ({
    orderBy: s.id,
    direction: s.desc ? "desc" : "asc",
  }));
};

export const defaultPagination: PaginationParams = {
  pageIndex: 0,
  pageSize: Math.min(50, MAX_PAGE_SIZE),
};
/**
 * The table's opening sort. Callers name it from the entity's declared sort
 * roster: a hardcoded field is not sortable on every entity (Run has no
 * `createdAt` sort) and a blanket direction opens name rosters Z-to-A.
 */
export const defaultSortState = (
  initialSort: string,
  initialSortDesc: boolean,
): SortingState => [{ id: initialSort, desc: initialSortDesc }];
