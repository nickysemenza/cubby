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
  initialSort?: string,
): SortParams => {
  const sortParams: SortParams = {
    direction: sorting[0]?.desc ? "desc" : "asc",
    orderBy: sorting[0]?.id ?? initialSort ?? "createdAt",
  };
  return sortParams;
};

/**
 * Full sort stack for the tRPC list input. Cleared sort falls back to the
 * table's default state — desc, matching `defaultSortState` (the old
 * single-sort fallback said asc, a latent mismatch that became reachable once
 * enableSortingRemoval lets a third click clear the sort).
 */
export const buildSortsParams = (
  sorting: SortingState,
  initialSort?: string,
): SortParams[] => {
  if (sorting.length === 0) {
    return [{ orderBy: initialSort ?? "createdAt", direction: "desc" }];
  }
  return sorting.slice(0, MAX_SORTS).map((s) => ({
    orderBy: s.id,
    direction: s.desc ? "desc" : "asc",
  }));
};

export const defaultPagination: PaginationParams = {
  pageIndex: 0,
  pageSize: Math.min(100, MAX_PAGE_SIZE),
};
export const defaultSortState = (initialSort?: string): SortingState => [
  { id: initialSort ?? "createdAt", desc: true },
];
