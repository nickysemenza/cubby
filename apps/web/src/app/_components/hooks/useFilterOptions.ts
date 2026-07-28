import { useMemo } from "react";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

/**
 * Stabilizes the `filterOptions` map every list page feeds `useEntityList`
 * for its manifest `optionsKey` picklists (the project roster, a recipe's tag
 * universe, ...). Every call site used to hand-build this as
 * `useMemo(() => ({ key: opts }), [opts])` — byte-identical at three sites
 * (purchases/tasks' `{ project }`, recipes' `{ tags }`) and about to gain a
 * fourth and fifth (`cookbook`, `parentLocation`) — so this collapses it to
 * one call, and handles the multi-key case recipes now need.
 *
 * Callers may pass a fresh object literal each render — like
 * `useStandardColumns`' `filters` prop, this hashes the VALUES (not the
 * argument's own identity) via `JSON.stringify`, so the returned reference
 * only changes when an option list's actual content does.
 */
export function useFilterOptions(
  map: Record<string, FilterableComboboxItem[]>,
): Record<string, FilterableComboboxItem[]> {
  const key = JSON.stringify(map);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - using the serialized key for deep comparison, mirrors useStandardColumns' `stableFilters`
  return useMemo(() => map, [key]);
}
