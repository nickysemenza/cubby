import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { z } from "zod";

import { defaultPagination } from "~/app/_components/data-table/tableUtils";
import {
  defineOperationDomain,
  infiniteOperationQueryKey,
  type OperationQueryKey,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

import { getEntityFilters } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
  type FilterPatch,
  paramToSort,
} from "./filters";
import {
  type EntityListInputByEntity,
  type EntityListParseInput,
  type EntityListParamsByEntity,
  type EntityListResultByEntity,
  entityListParamsFromParsed,
  entityListInputFor,
  getEntityListOutputSchema,
  type ListEntity,
  parseEntityListInput,
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
    parse: (result, input) =>
      getEntityListOutputSchema(input.entity).parse(result),
    tags: [["entity", "list"]],
    freshness: (input) =>
      stableIndexEntities.has(input.entity) ? stableIndexFreshness : undefined,
  }),
});

export type EntityListParams<E extends ListEntity> =
  EntityListParamsByEntity[E];
interface CompileEntityListOptions {
  pageSize?: number;
  defaultSort?: { orderBy: string; direction: "asc" | "desc" };
  groupBy?: string;
}

/**
 * Compile validated route search into the exact first-page input consumed by
 * both the route loader and the infinite table. Keeping this pure means SSR,
 * hydration, preloads, and Back/Forward all share a canonical cache key.
 */
export function compileEntityListInput<E extends ListEntity>(
  entity: E,
  validatedSearch: FilterPatch,
  options: CompileEntityListOptions = {},
): EntityListParams<E> {
  const parsedSort = paramToSort(validatedSearch.sort)?.map((term) => ({
    orderBy: term.id,
    direction: term.desc ? ("desc" as const) : ("asc" as const),
  }));
  const input: EntityListParseInput = {
    entity,
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
  };
  if (options.groupBy) input.groupBy = options.groupBy;
  return entityListParamsFromParsed(
    entity,
    parseEntityListInput(entity, input),
  );
}

/**
 * Bind `entity.list` to one entity, so its filters, rows, and cache key all
 * carry that entity's types. Throws for an entity the operation is not
 * registered for.
 */
export function entityListFor<E extends ListEntity>(entity: E) {
  const operation = entityList.list.forEntity(entity);
  const wireInputFor = (input: EntityListParams<E>) =>
    entityListInputFor(entity, input);
  const queryKeyFor = (
    input: EntityListInputByEntity[E],
  ): OperationQueryKey<EntityListInputByEntity[E]> => [
    "operation",
    operation.id,
    { entity, input },
  ];
  const call = async (
    input: EntityListInputByEntity[E],
    signal?: AbortSignal,
  ): Promise<EntityListResultByEntity[E]> => {
    const result = await operation.call(input, { signal });
    return getEntityListOutputSchema(entity).parse(result);
  };
  const keyInputFor = (wireInput: EntityListInputByEntity[E]) => {
    try {
      return parseEntityListInput(entity, wireInput);
    } catch {
      // Conditional queries may carry incomplete filters while disabled. Their
      // query function remains authoritative for validation if they execute.
      return wireInput;
    }
  };
  const firstPageOf = (input: EntityListParams<E>) => ({
    ...input,
    pagination: { ...input.pagination, pageIndex: 0 },
  });
  return {
    entity,
    queryKey: (input: EntityListParams<E>) =>
      queryKeyFor(keyInputFor(wireInputFor(input))),
    queryOptions: (input: EntityListParams<E>) => {
      const wireInput = wireInputFor(input);
      const keyInput = keyInputFor(wireInput);
      const policy = operation.policy(keyInput);
      return queryOptions({
        queryKey: queryKeyFor(keyInput),
        queryFn: async ({ signal }) =>
          call(parseEntityListInput(entity, wireInput), signal),
        meta: policy.meta,
        ...policy.freshness,
      });
    },
    /**
     * The table pager consumes a finite plan, not raw React Query options.
     * Keep that adapter beside the descriptor so table callers cannot erase a
     * row type while reaching through `queryFn` themselves.
     */
    listQueryPlan: (input: EntityListParams<E>) => {
      const wireInput = wireInputFor(input);
      const keyInput = keyInputFor(wireInput);
      const policy = operation.policy(keyInput);
      return {
        queryKey: queryKeyFor(keyInput),
        meta: policy.meta,
        execute: (signal: AbortSignal) =>
          Promise.resolve(
            call(parseEntityListInput(entity, wireInput), signal),
          ),
      };
    },
    /** Query options shared by SSR loaders and the mounted infinite table. */
    infiniteQueryOptions: (input: EntityListParams<E>) => {
      const firstPage = firstPageOf(input);
      const parsed = parseEntityListInput(entity, wireInputFor(firstPage));
      const policy = operation.policy(parsed);
      return infiniteQueryOptions({
        queryKey: infiniteOperationQueryKey(queryKeyFor(parsed)),
        queryFn: async ({ pageParam, signal }) =>
          call(
            parseEntityListInput(entity, {
              ...wireInputFor(firstPage),
              pagination: { ...firstPage.pagination, pageIndex: pageParam },
            }),
            signal,
          ),
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
    },
  };
}

export type EntityListScoped<E extends ListEntity> = ReturnType<
  typeof entityListFor<E>
>;
