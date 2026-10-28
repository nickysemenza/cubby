import { parseShortcode } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";

import type { ListFacet } from "~/contracts/entity-list.contract";
import { getEntityFilters } from "~/entity/filter-manifest";
import { buildFiltersFromManifest } from "~/entity/filters";
import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import { viewsForEntity } from "~/entity/model/view-manifest";
import { entityList } from "~/integrations/tanstack-query/generated/domains/entityList.gen";
import type { FilterBarField } from "~/ui/data-table/filter-bar-core";

/**
 * The page list's server query, published by `GenericEntityList` to its
 * workbench: the filters the list request sends (facets count under them),
 * the filtered total, and the strip above the records the active-filter
 * chips render into.
 */
export interface ListQueryState {
  entity: ListEntity;
  filters: object;
  matching: number | undefined;
  chipsTarget: HTMLElement | null;
}

const ListQueryContext = createContext<ListQueryState | null>(null);

export function ListQueryProvider({
  value,
  children,
}: {
  value: ListQueryState;
  children: ReactNode;
}) {
  return <ListQueryContext value={value}>{children}</ListQueryContext>;
}

/** The page list's query, when `entity` is the page's own list. */
export function useListQuery(entity: string | undefined) {
  const query = useContext(ListQueryContext);
  return query && query.entity === entity ? query : null;
}

const bareCode = (value: string) => parseShortcode(value)?.shortcode ?? value;

/**
 * Facets for the open editor and the active filters only, under the list's
 * other filters. Counts are advisory: a failed or pending read shows none.
 */
export function useFilterFacets(
  query: ListQueryState | null,
  facetIds: readonly string[],
): ReadonlyMap<string, ListFacet> {
  const ids = [...new Set(facetIds)].sort().slice(0, 12);
  const result = useQuery({
    ...entityList.facetCounts.queryOptions({
      entity: query?.entity ?? "product",
      filters: { ...query?.filters },
      facetIds: ids.length > 0 ? ids : ["-"],
    }),
    enabled: query !== null && ids.length > 0,
    placeholderData: keepPreviousData,
  });
  return useMemo(
    () =>
      new Map(
        result.isError
          ? []
          : (result.data?.facets ?? []).map((facet) => [facet.id, facet]),
      ),
    [result.data, result.isError],
  );
}

/** Overlays loaded facets: option counts as hints, a range's min/max as bounds. */
export function withFacets(
  fields: FilterBarField[],
  facets: ReadonlyMap<string, ListFacet>,
): FilterBarField[] {
  if (facets.size === 0) return fields;
  return fields.map((field) => {
    const facet = facets.get(field.key);
    if (!facet) return field;
    if (facet.kind === "range")
      return (facet.unresolvedCount ?? 0) > 0
        ? field
        : { ...field, bounds: { min: facet.min, max: facet.max } };
    const counts = new Map(
      facet.options.map((option) => [bareCode(option.value), option.count]),
    );
    return {
      ...field,
      options: field.options?.map((option) =>
        // A meta option (No value, Any value) is a predicate, not a value the
        // facet counts; a 0 there would be wrong, so it carries no hint.
        option.hint !== undefined || option.meta
          ? option
          : {
              ...option,
              hint: `${counts.get(bareCode(option.value)) ?? 0}${(facet.unresolvedCount ?? 0) > 0 ? " known" : ""}`,
            },
      ),
    };
  });
}

/** Each declared saved view's count and the unfiltered total ("All"). */
export function useViewCounts(entity: ListEntity | undefined, enabled = false) {
  const queryClient = useQueryClient();
  const views = useMemo(() => {
    if (!entity) return [];
    const specs = getEntityFilters(queryClient, entity);
    return viewsForEntity(queryClient, entity).map((view) => {
      const values = new Map(view.filters.map(({ id, value }) => [id, value]));
      return {
        id: view.id,
        filters: buildFiltersFromManifest(specs, (id) => values.get(id)),
      };
    });
  }, [entity, queryClient]);
  const result = useQuery({
    ...entityList.viewCounts.queryOptions({
      entity: entity ?? "product",
      views,
    }),
    enabled: enabled && entity !== undefined,
  });
  return useMemo(
    () => ({
      total: result.isError ? undefined : result.data?.total,
      unresolvedCounts: new Map(
        result.isError
          ? []
          : (result.data?.views ?? []).map((view) => [
              view.id,
              view.unresolvedCount ?? 0,
            ]),
      ),
      counts: new Map(
        result.isError
          ? []
          : (result.data?.views ?? []).map((view) => [view.id, view.count]),
      ),
    }),
    [result.data, result.isError],
  );
}
