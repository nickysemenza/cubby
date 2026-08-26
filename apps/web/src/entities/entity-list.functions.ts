import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { defaultPagination } from "~/app/_components/data-table/tableUtils";
import {
  defineOperationDomain,
  type InfiniteOperationQueryKey,
  infiniteOperationQueryKey,
  type OperationQueryKey,
  query,
} from "~/integrations/tanstack-query/operation-catalog";
import { getEntityFilters } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
  paramToSort,
} from "./filters";
import {
  type EntityListInputByEntity,
  type EntityListResultByEntity,
  type ListEntity,
  parseEntityListInput,
  parseEntityListResult,
} from "./generated/entity-lists.gen";

const stableIndexEntities = new Set<ListEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
]);
const stableIndexFreshness = {
  staleTime: 2 * 60_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

/** @lintignore Discovered by the operation registry generator. */
export const entityList = defineOperationDomain("entity", {
  list: query({
    input: z.custom<EntityListInputByEntity[ListEntity]>(),
    output: z.custom<EntityListResultByEntity[ListEntity]>(),
    parse: (result, input) => parseEntityListResult(input.entity, result),
    tags: [["entity", "list"]],
    freshness: (input) =>
      stableIndexEntities.has(input.entity) ? stableIndexFreshness : undefined,
  }),
});

export type EntityListParams<E extends ListEntity> = Omit<
  EntityListInputByEntity[E],
  "entity"
>;

/**
 * Compile validated route search into the exact first-page input consumed by
 * both the route loader and the infinite table. Keeping this pure means SSR,
 * hydration, preloads, and Back/Forward all share a canonical cache key.
 */
export function compileEntityListInput<E extends ListEntity>(
  entity: E,
  validatedSearch: Record<string, unknown>,
  options?: {
    pageSize?: number;
    defaultSort?: { orderBy: string; direction: "asc" | "desc" };
    groupBy?: string;
  },
): EntityListParams<E>;
export function compileEntityListInput(
  entity: ListEntity,
  validatedSearch: Record<string, unknown>,
  options: {
    pageSize?: number;
    defaultSort?: { orderBy: string; direction: "asc" | "desc" };
    groupBy?: string;
  } = {},
): unknown {
  const parsedSort = paramToSort(validatedSearch.sort)?.map((term) => ({
    orderBy: term.id,
    direction: term.desc ? ("desc" as const) : ("asc" as const),
  }));
  return {
    filters: buildFiltersFromManifest(
      getEntityFilters(entity),
      filterGetterFromSearch(getEntityFilters(entity), validatedSearch),
    ),
    sort: parsedSort ?? [
      options.defaultSort ?? { orderBy: "createdAt", direction: "desc" },
    ],
    pagination: {
      pageIndex: 0,
      pageSize: options.pageSize ?? defaultPagination.pageSize,
    },
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
  };
}

export const entityListRootKey = <E extends ListEntity>(_entity: E) =>
  ["operation", entityList.list.id] as const;

export function entityListQueryOptions<E extends ListEntity>(
  entity: E,
  input: EntityListParams<E>,
) {
  const operation = entityList.list.forEntity(entity);
  const parsed = parseEntityListInput(entity, {
    entity,
    ...input,
  }) as EntityListInputByEntity[E];
  const policy = operation.policy(parsed);
  return queryOptions({
    queryKey: operation.queryKey(parsed) as OperationQueryKey<
      EntityListInputByEntity[E]
    >,
    queryFn: async ({ signal }) =>
      (await operation.call(parsed, { signal })) as EntityListResultByEntity[E],
    meta: policy.meta,
    ...policy.freshness,
  });
}

/** Query options shared by SSR loaders and the mounted infinite table. */
export function entityInfiniteListQueryOptions<E extends ListEntity>(
  entity: E,
  input: EntityListParams<E>,
) {
  const firstPage = {
    ...input,
    pagination: { ...input.pagination, pageIndex: 0 },
  };
  const operation = entityList.list.forEntity(entity);
  const parsed = parseEntityListInput(entity, {
    entity,
    ...firstPage,
  }) as EntityListInputByEntity[E];
  const policy = operation.policy(parsed);
  return infiniteQueryOptions({
    queryKey: infiniteOperationQueryKey(
      operation.queryKey(parsed),
    ) as InfiniteOperationQueryKey<EntityListInputByEntity[E]>,
    queryFn: async ({ pageParam, signal }) => {
      const pageInput = parseEntityListInput(entity, {
        entity,
        ...firstPage,
        pagination: { ...firstPage.pagination, pageIndex: pageParam },
      }) as EntityListInputByEntity[E];
      return (await operation.call(pageInput, {
        signal,
      })) as EntityListResultByEntity[E];
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const { pageIndex, pageSize, totalCount } = lastPage.meta;
      return (pageIndex + 1) * pageSize < totalCount
        ? pageIndex + 1
        : undefined;
    },
    meta: policy.meta,
    ...policy.freshness,
  });
}
