import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { entityFilterOptions } from "~/entities/entity-filter-options.functions";
import {
  getEntityFilters,
  referenceFilterOptionsKey,
} from "~/entities/filter-manifest";

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
  const activate = useCallback(
    (key: string, selectedIds: readonly string[] = []) => {
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
