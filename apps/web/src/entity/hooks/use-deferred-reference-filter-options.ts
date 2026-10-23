import { type BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  useEntityDisplayImages,
  useEntityDisplayImageMap,
  entityDisplayImageKey,
} from "~/entity/entity-media/entity-display-images";
import {
  getEntityFilters,
  referenceFilterOptionsKey,
} from "~/entity/filter-manifest";
import { recordFilterOption } from "~/entity/filter-option-presentation";
import { isPickerEntity, recordSource } from "~/entity/picker/picker";
import { entityFilterOptions } from "~/integrations/tanstack-query/generated/catalog/entityFilterOptions.gen";
import type { RuntimeFilterOptions } from "~/ui/hooks/filter-option-types";

/**
 * Generic live rosters for every manifest entity-reference filter, including
 * one with an `optionsKey` its list's caller may not supply.
 */
export function useDeferredReferenceFilterOptions(
  entity: BrowserRoutedEntity,
): RuntimeFilterOptions {
  const references = useMemo(
    () =>
      getEntityFilters(entity).flatMap((spec) => {
        if (!spec.referenceEntity) return [];
        const key = referenceFilterOptionsKey(spec);
        return key ? [{ key, target: spec.referenceEntity }] : [];
      }),
    [entity],
  );
  return useDeferredEntityRosters(references);
}

type FilterOptionsPage = Awaited<
  ReturnType<typeof entityFilterOptions.filterOptions.call>
>;
const rosterResults = (
  results: readonly { data?: FilterOptionsPage; isFetching: boolean }[],
) => results.map(({ data, isFetching }) => ({ data, isFetching }));

export type DeferredEntityRoster = {
  key: string;
  target: BrowserRoutedEntity;
};

/** Live, searchable shortcode rosters fetched only once their filter opens.
 * `references` must be stable (a module constant or memoized value). */
export function useDeferredEntityRosters(
  references: readonly DeferredEntityRoster[],
): RuntimeFilterOptions {
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
        include: ["emoji"],
      }),
      enabled: active[key] === true,
    })),
    // A stable result keeps the returned rosters (and any column set built
    // from them) unchanged across unrelated renders.
    combine: rosterResults,
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
  const inheritedImages = useEntityDisplayImageMap();
  const images = useEntityDisplayImages(
    references.flatMap(({ target }, index) =>
      (queries[index]?.data?.items ?? []).map((item) => ({
        entityKind: target,
        entityId: item.id,
      })),
    ),
    inheritedImages,
  );
  return useMemo(
    () =>
      Object.fromEntries(
        references.map(({ key, target }, index) => {
          const query = queries[index];
          return [
            key,
            {
              options:
                query?.data?.items.map((item) =>
                  recordFilterOption(
                    target,
                    item,
                    images[
                      entityDisplayImageKey({
                        entityKind: target,
                        entityId: item.id,
                      })
                    ] ?? null,
                  ),
                ) ?? [],
              onActivate: (selectedIds?: readonly string[]) =>
                activate(key, selectedIds),
              onSearchChange: (value: string) =>
                setSearch((current) =>
                  current[key] === value
                    ? current
                    : { ...current, [key]: value },
                ),
              isLoading: query?.isFetching ?? false,
              ...(isPickerEntity(target)
                ? { records: recordSource(target) }
                : {}),
            },
          ];
        }),
      ),
    [activate, queries, references, images],
  );
}
