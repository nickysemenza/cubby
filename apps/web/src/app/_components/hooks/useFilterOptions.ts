import { useMemo } from "react";

import {
  filterOptionItems,
  type RuntimeFilterOptions,
} from "./filter-option-types";

/**
 * Stabilizes the `filterOptions` map every list page feeds `useEntityList`
 * for its manifest `optionsKey` picklists (the project roster, a recipe's tag
 * universe, ...). Every call site used to hand-build this as
 * `useMemo(() => ({ key: opts }), [opts])` — byte-identical at three sites
 * (expenses/tasks' `{ project }`, recipes' `{ tags }`) and about to gain a
 * fourth and fifth (`cookbook`, `parentLocation`) — so this collapses it to
 * one call, and handles the multi-key case recipes now need.
 *
 * Callers may pass a fresh object literal each render — like
 * `useStandardColumns`' `filters` prop, this hashes the VALUES (not the
 * argument's own identity), so the returned reference only changes when an
 * option list's actual content does.
 *
 * The hash covers the DATA fields only. `icon` is a React element, and
 * `JSON.stringify` on one throws "Converting circular structure to JSON" (a
 * fiber node points back at its DOM node) — which took the whole expenses
 * ledger down the moment the vendor roster started carrying brand marks.
 * Skipping it is also correct, not just safe: an option's icon is derived from
 * its value, so it can't change while every field below stays put.
 */
export function useFilterOptions(
  map: RuntimeFilterOptions,
): RuntimeFilterOptions {
  const key = JSON.stringify(
    Object.entries(map).map(([optionsKey, source]) => [
      optionsKey,
      filterOptionItems(source).map((item) => [
        item.value,
        item.label,
        item.detail,
        item.hint,
        item.color,
        item.meta,
        item.group,
        item.depth,
        item.rowLabel,
      ]),
      Array.isArray(source) ? false : source.isLoading,
    ]),
  );
  // oxlint-disable-next-line react/exhaustive-deps -- intentional - using the serialized key for deep comparison, mirrors useStandardColumns' `stableFilters`
  return useMemo(() => map, [key]);
}
