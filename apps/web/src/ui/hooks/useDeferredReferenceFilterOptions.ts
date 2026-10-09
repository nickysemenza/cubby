import { type BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  getEntityFilters,
  referenceFilterOptionsKey,
} from "~/entity/filter-manifest";
import { entityFilterOptions } from "~/integrations/tanstack-query/generated/catalog.gen";

import type { RuntimeFilterOptions } from "./filter-option-types";

/** Generic live rosters for unscoped manifest entity-reference filters. */
export function useDeferredReferenceFilterOptions(
  entity: BrowserRoutedEntity,
): RuntimeFilterOptions {
  const references = useMemo(
    () =>
      getEntityFilters(entity).flatMap((spec) => {
        if (spec.optionsKey || !spec.referenceEntity) return [];
        const key = referenceFilterOptionsKey(spec);
        return key ? [{ key, target: spec.referenceEntity }] : [];
      }),
    [entity],
  );
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState<Record<string, string>>({});
  const [debouncedSearch] = useDebouncedValue(search, { wait: 250 });
  const [selected, setSelected] = useState<Record<string, readonly string[]>>(
    {},
  );
  const queries = useQueries({
    queries: references.map(({ key, target }) => ({
      ...entityFilterOptions.filterOptions.queryOptions({
        source: "entity" as const,
        entity: target,
        search: debouncedSearch[key] ?? "",
        selectedIds: [...(selected[key] ?? [])],
        limit: 25,
      }),
      enabled: active[key] === true,
    })),
  });
  // FilterBar re-activates an active filter after every commit. Comparing
  // against the last request, not the updater's `current`, keeps that from
  // enqueueing again: an update in a low-priority lane (a list hydrated at idle
  // priority) is rebased from its base state on every urgent render, so the
  // updater sees `{}` each time, returns a new object, and re-fires the effect
  // (regression: /plantings?plantId=… re-rendered ~500×/s and a bulk-edit
  // picker then hit React's maximum update depth).
  const requested = useRef<Record<string, readonly string[]>>({});
  const activate = useCallback(
    (key: string, selectedIds: readonly string[] = []) => {
      const previous = requested.current[key];
      if (
        previous?.length === selectedIds.length &&
        previous.every((id, index) => id === selectedIds[index])
      )
        return;
      requested.current = { ...requested.current, [key]: [...selectedIds] };
      setActive((current) =>
        current[key] ? current : { ...current, [key]: true },
      );
      setSelected((current) =>
        current[key]?.every((id, index) => id === selectedIds[index]) &&
        current[key].length === selectedIds.length
          ? current
          : { ...current, [key]: [...selectedIds] },
      );
    },
    [],
  );
  return useMemo(
    () =>
      Object.fromEntries(
        references.map(({ key }, index) => {
          const query = queries[index];
          return [
            key,
            {
              options:
                query?.data?.items.map((item) => ({
                  value: item.id,
                  label: item.label,
                  detail: item.detail,
                })) ?? [],
              onActivate: (selectedIds?: readonly string[]) =>
                activate(key, selectedIds),
              onSearchChange: (value: string) =>
                setSearch((current) =>
                  current[key] === value
                    ? current
                    : { ...current, [key]: value },
                ),
              isLoading: query?.isFetching ?? false,
            },
          ];
        }),
      ),
    [activate, queries, references],
  );
}
