import type { ColumnFiltersState } from "@tanstack/react-table";
import { useMemo } from "react";

/**
 * Seeds a single column filter from a route search param (e.g. a
 * command-palette deep link — `?q=` on tasks/expenses, `?category=` on
 * products) and returns the `tableStateOptions` object `useEntityList`
 * expects. Mount-only: this only sets the *initial* filter value: typing in
 * the search box afterwards behaves normally and does not sync back to the
 * URL.
 */
export function useSeededFilter(
  columnId: string,
  seedValue: string | undefined,
) {
  const initialFilter = useMemo((): ColumnFiltersState => {
    if (!seedValue) return [];
    return [{ id: columnId, value: seedValue }];
  }, [columnId, seedValue]);

  return useMemo(() => ({ initialFilter }), [initialFilter]);
}
