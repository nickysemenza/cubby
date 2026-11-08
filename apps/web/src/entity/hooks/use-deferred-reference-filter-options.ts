import { type BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import {
  tagFilterEntity,
  type FilterOptionsInput,
} from "@cubby/schemas/filter-options";
import { relatedViewKeySchema } from "@cubby/schemas/related-view";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQueryClient } from "@tanstack/react-query";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
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
import { entityFilterOptions } from "~/integrations/tanstack-query/generated/domains/entityFilterOptions.gen";
import type { RuntimeFilterOptions } from "~/ui/combobox/filter-option-types";

/**
 * Live rosters for declared reference and tag filters, including embedded
 * lists whose callers supply no runtime options.
 */
export function useDeferredReferenceFilterOptions(
  entity: BrowserRoutedEntity,
): RuntimeFilterOptions {
  const queryClient = useQueryClient();
  const references = useMemo(
    () =>
      getEntityFilters(queryClient, entity).flatMap<
        DeferredEntityRoster | DeferredTagRoster
      >((spec) => {
        const tagEntity = tagFilterEntity.safeParse(entity);
        if (spec.optionsKey === "tags" && tagEntity.success)
          return [{ key: "tags", target: tagEntity.data, tags: true }];
        if (!spec.referenceEntity) return [];
        const key = referenceFilterOptionsKey(spec);
        return key
          ? [
              {
                key,
                target: spec.referenceEntity,
                optionsKind: spec.referenceOptionsKind,
                relationKey:
                  spec.optionSource?.kind === "relation"
                    ? relatedViewKeySchema.parse(spec.optionSource.relationKey)
                    : undefined,
              },
            ]
          : [];
      }),
    [entity, queryClient],
  );
  return useDeferredEntityRosters(references);
}

type FilterOptionsPage = Awaited<
  ReturnType<typeof entityFilterOptions.filterOptions.call>
>;
const rosterResults = (
  results: readonly Pick<
    UseQueryResult<FilterOptionsPage>,
    "data" | "isFetching" | "error" | "refetch"
  >[],
) =>
  results.map(({ data, isFetching, error, refetch }) => ({
    data,
    isFetching,
    error,
    refetch,
  }));

export type DeferredEntityRoster = {
  tags?: never;
  key: string;
  target: BrowserRoutedEntity;
  relationKey?: string;
  optionsKind?:
    | "locationWithInventory"
    | "ingredientWithProduct"
    | "locationIdentityProduct";
};

type DeferredTagRoster = {
  key: string;
  target: Extract<FilterOptionsInput, { source: "tags" }>["entity"];
  tags: true;
  relationKey?: never;
  optionsKind?: never;
};

/** Live, searchable shortcode rosters fetched only once their filter opens.
 * `references` must be stable (a module constant or memoized value). */
export function useDeferredEntityRosters(
  references: readonly (DeferredEntityRoster | DeferredTagRoster)[],
): RuntimeFilterOptions {
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState<Record<string, string>>({});
  const [debouncedSearch] = useDebouncedValue(search, { wait: 250 });
  const [selected, setSelected] = useState<Record<string, readonly string[]>>(
    {},
  );
  // Selection hydration is independent: choosing a later row must not reset
  // the browsed pages or re-fetch every page under a different selection key.
  const [pages, setPages] = useState<
    Record<string, { scope: string; cursors: (string | undefined)[] }>
  >({});
  const requests = useMemo(
    () =>
      references.flatMap((reference) => {
        const { key } = reference;
        const scope = debouncedSearch[key] ?? "";
        const cursors =
          pages[key]?.scope === scope ? pages[key].cursors : [undefined];
        return [
          ...cursors.map((cursor) => ({
            ...reference,
            cursor,
            scope,
            selection: false,
          })),
          ...((selected[key]?.length ?? 0) > 0
            ? [{ ...reference, cursor: undefined, scope, selection: true }]
            : []),
        ];
      }),
    [references, debouncedSearch, selected, pages],
  );
  const queries = useQueries({
    queries: requests.map(
      ({ key, target, tags, optionsKind, relationKey, cursor, selection }) => ({
        ...entityFilterOptions.filterOptions.queryOptions({
          ...(tags
            ? { source: "tags" as const, entity: target }
            : relationKey
              ? {
                  source: "relation" as const,
                  relationKey: relatedViewKeySchema.parse(relationKey),
                }
              : optionsKind
                ? { source: "kind" as const, kind: optionsKind }
                : {
                    source: "entity" as const,
                    entity: target,
                    include: ["emoji" as const],
                  }),
          search: selection ? "" : (debouncedSearch[key] ?? ""),
          selectedIds: selection ? [...(selected[key] ?? [])] : [],
          cursor,
          limit: selection ? 1 : 25,
        }),
        enabled: active[key] === true,
      }),
    ),
    combine: rosterResults,
  });
  const rosters = useMemo(
    () =>
      references.map(({ key }) => {
        const indices = requests.flatMap((request, index) =>
          request.key === key && !request.selection ? [index] : [],
        );
        const items = new Map(
          indices.flatMap((index) =>
            (queries[index]?.data?.items ?? []).map(
              (item) => [item.id, item] as const,
            ),
          ),
        );
        const selectionIndex = requests.findIndex(
          (request) => request.key === key && request.selection,
        );
        const selectedIds = new Set(selected[key] ?? []);
        for (const item of queries[selectionIndex]?.data?.items ?? []) {
          if (selectedIds.has(item.id)) items.set(item.id, item);
        }
        const lastIndex = indices.at(-1);
        const first = queries[indices[0] ?? -1];
        const last = queries[lastIndex ?? -1];
        const failed = [...indices, selectionIndex]
          .map((index) => queries[index])
          .find((query) => query?.error);
        return {
          items: [...items.values()],
          first,
          last,
          failed,
          request: requests[lastIndex ?? -1],
        };
      }),
    [references, requests, queries, selected],
  );
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
    references.flatMap(({ target, tags }, index) =>
      tags
        ? []
        : (rosters[index]?.items ?? []).map((item) => ({
            entityKind: target,
            entityId: item.id,
          })),
    ),
    inheritedImages,
  );
  return useMemo(
    () =>
      Object.fromEntries(
        references.map(({ key, target, tags }, index) => {
          const roster = rosters[index];
          const searching =
            (search[key] ?? "") !== (debouncedSearch[key] ?? "");
          const nextCursor = roster?.last?.data?.nextCursor;
          const fetchingNext = Boolean(
            roster?.request?.cursor && roster.last?.isFetching,
          );
          return [
            key,
            {
              options:
                roster?.items.map((item) =>
                  tags
                    ? {
                        value: item.id,
                        label: item.label,
                        hint:
                          item.count === undefined
                            ? undefined
                            : String(item.count),
                      }
                    : recordFilterOption(
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
              isLoading: searching || (roster?.first?.isFetching ?? false),
              isFetchingNextPage: fetchingNext,
              hasNextPage: Boolean(nextCursor),
              error: roster?.failed?.error?.message ?? null,
              onRetry: () => {
                void roster?.failed?.refetch();
              },
              onLoadMore: () => {
                if (
                  searching ||
                  !nextCursor ||
                  roster?.last?.isFetching ||
                  roster?.failed ||
                  !roster?.request
                )
                  return;
                const scope = roster.request.scope;
                setPages((current) => {
                  const cursors =
                    current[key]?.scope === scope
                      ? current[key].cursors
                      : [undefined];
                  return cursors.includes(nextCursor)
                    ? current
                    : {
                        ...current,
                        [key]: { scope, cursors: [...cursors, nextCursor] },
                      };
                });
              },
              ...(!tags && isPickerEntity(target)
                ? { records: recordSource(target) }
                : {}),
            },
          ];
        }),
      ),
    [activate, rosters, references, images, search, debouncedSearch],
  );
}
