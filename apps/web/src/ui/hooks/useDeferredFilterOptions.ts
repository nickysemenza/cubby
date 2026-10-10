import type { FilterOptionKind } from "@cubby/schemas/filter-options";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import { entityFilterOptions } from "~/integrations/tanstack-query/generated/catalog.gen";

import type { DeferredFilterOptionSource } from "./filter-option-types";

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

/**
 * A dormant, server-searched filter roster. The first page is requested only
 * when the filter is active/open; selected ids are always included so a saved
 * view can render labels even when its values fall outside the current page.
 */
export function useDeferredFilterOptions(
  kind: FilterOptionKind,
): DeferredFilterOptionSource {
  const [active, setActive] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [search] = useDebouncedValue(searchInput, { wait: 250 });

  const query = useQuery({
    ...entityFilterOptions.filterOptions.queryOptions({
      kind,
      search,
      selectedIds: [...selectedIds],
      limit: 25,
    }),
    enabled: active,
  });

  // Compared against the last request, not the updater's `current`: see
  // `useDeferredReferenceFilterOptions` (a rebased low-priority update would
  // otherwise return a new array on every render and re-fire FilterBar).
  const requested = useRef<readonly string[] | null>(null);
  const onActivate = useCallback((nextSelectedIds: readonly string[] = []) => {
    if (requested.current && sameIds(requested.current, nextSelectedIds))
      return;
    requested.current = [...nextSelectedIds];
    setActive(true);
    setSelectedIds((current) =>
      sameIds(current, nextSelectedIds) ? current : [...nextSelectedIds],
    );
  }, []);

  const options = useMemo(
    () =>
      query.data?.items.map((item) => ({
        value: item.id,
        label: item.label,
        detail: item.detail,
      })) ?? [],
    [query.data],
  );

  return useMemo(
    () => ({
      options,
      onActivate,
      onSearchChange: setSearchInput,
      isLoading: query.isFetching,
    }),
    [onActivate, options, query.isFetching],
  );
}
