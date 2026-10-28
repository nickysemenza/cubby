import type { ListGroupBy, ListNesting } from "@cubby/schemas/pagination";
import {
  infiniteQueryOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";

import { entityList } from "~/integrations/tanstack-query/domains/entityList";
import {
  infiniteOperationQueryKey,
  type OperationQueryKey,
} from "~/integrations/tanstack-query/operation-catalog";
import { defaultPagination } from "~/ui/data-table/table-utils";

import { listGroupBy } from "./entity-list/list-grouping";
import type { ListSearch } from "./entity-list/list-slot-types";
import { correlateEntityList } from "./entity-read-result";
import { getEntityFilters } from "./filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
  paramToSort,
} from "./filters";
import {
  type EntityListInputByEntity,
  type EntityListParseInput,
  type EntityListParamsByEntity,
  type EntityListResultByEntity,
  type EntitySelectedListResultByEntity,
  entityListParamsFromParsed,
  entityListInputFor,
  type ListEntity,
  parseEntityListInput,
} from "./generated/entity-lists.gen";
import { entityMetadata } from "./metadata";

export type EntityListParams<E extends ListEntity> =
  EntityListParamsByEntity[E];
interface CompileEntityListOptions {
  includeCount?: boolean;
  pageSize?: number;
  defaultSort?: { orderBy: string; direction: "asc" | "desc" };
  groupBy?: ListGroupBy[];
  /** A nested table's root scope (`listNested`). */
  nesting?: ListNesting;
  fields?: string[];
}

/**
 * Compile validated route search into the exact first-page input consumed by
 * both the route loader and the infinite table. Keeping this pure means SSR,
 * hydration, preloads, and Back/Forward all share a canonical cache key.
 */
export function compileEntityListInput<E extends ListEntity>(
  queryClient: QueryClient,
  entity: E,
  validatedSearch: ListSearch,
  options: CompileEntityListOptions = {},
): EntityListParams<E> {
  const metadata = entityMetadata(queryClient, entity);
  const filters = getEntityFilters(queryClient, entity);
  const parsedSort = paramToSort(validatedSearch.sort)?.map((term) => ({
    orderBy: term.id,
    direction: term.desc ? ("desc" as const) : ("asc" as const),
  }));
  const searching = Boolean(validatedSearch.searchQuery);
  const input: EntityListParseInput = {
    entity,
    filters: buildFiltersFromManifest(
      filters,
      filterGetterFromSearch(filters, validatedSearch),
    ),
    pagination: {
      pageIndex: 0,
      pageSize: options.pageSize ?? defaultPagination.pageSize,
    },
    includeCount: options.includeCount ?? false,
    fields: options.fields,
  };
  // Omitted rather than an empty array: server list search recognizes the
  // absence of a user sort and opens in lexical relevance order. A URL sort
  // remains authoritative, including the entity's ordinary default when a
  // person selected it deliberately.
  if (parsedSort) input.sort = parsedSort;
  else if (!searching) {
    input.sort = [
      options.defaultSort ?? {
        orderBy: metadata.sort?.default ?? "createdAt",
        direction: metadata.sort?.direction ?? "desc",
      },
    ];
  }
  const dimensions = options.groupBy ?? listGroupBy(validatedSearch);
  if (dimensions?.length) input.groupBy = dimensions;
  if (options.nesting) input.nesting = options.nesting;
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
export function entityListFor<E extends ListEntity>(
  entity: E,
  /** Test seam: a `withTransport` twin of the production list operation. */
  listOperation: typeof entityList.list = entityList.list,
) {
  const operation = listOperation.forEntity(entity);
  const wireInputFor = (input: EntityListParams<E>) =>
    entityListInputFor(entity, {
      ...input,
      includeCount: input.includeCount ?? true,
    });
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
    consistency?: "strong",
  ): Promise<EntityListResultByEntity[E]> => {
    if (input.fields !== undefined)
      throw new Error(
        "Selected list fields require the selected list query plan",
      );
    const result = await operation.call(input, { signal, consistency });
    if ("selectedFields" in result)
      throw new Error("A complete list returned a selected projection");
    return correlateEntityList(entity, result);
  };
  const selectedCall = async (
    input: EntityListInputByEntity[E],
    signal?: AbortSignal,
    consistency?: "strong",
  ): Promise<EntitySelectedListResultByEntity[ListEntity]> => {
    const result = await operation.call(input, { signal, consistency });
    if (!("selectedFields" in result))
      throw new Error("A selected list returned no projection witness");
    if (
      result.selectedFields.length !== input.fields?.length ||
      result.selectedFields.some(
        (field, index) => field !== input.fields?.[index],
      )
    )
      throw new Error(
        "A selected list returned different fields than requested",
      );
    return result;
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
    queryOptions: (
      input: EntityListParams<E>,
      readOptions?: { consistency?: "strong" },
    ) => {
      const wireInput = wireInputFor(input);
      const keyInput = keyInputFor(wireInput);
      const policy = operation.policy(keyInput);
      return queryOptions({
        queryKey: queryKeyFor(keyInput),
        queryFn: async ({ signal, client, queryKey }) =>
          call(
            parseEntityListInput(entity, wireInput),
            signal,
            readOptions?.consistency ??
              (client.getQueryState(queryKey)?.isInvalidated
                ? "strong"
                : undefined),
          ),
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
        execute: (signal: AbortSignal, consistency?: "strong") =>
          Promise.resolve(
            call(parseEntityListInput(entity, wireInput), signal, consistency),
          ),
      };
    },
    selectedListQueryPlan: (input: EntityListParams<E>) => {
      if (input.fields === undefined)
        throw new Error("A selected list query requires fields");
      const parsed = parseEntityListInput(entity, wireInputFor(input));
      const policy = operation.policy(parsed);
      return {
        queryKey: queryKeyFor(parsed),
        meta: policy.meta,
        execute: (signal: AbortSignal, consistency?: "strong") =>
          selectedCall(parsed, signal, consistency),
      };
    },
    browserInfiniteQueryOptions: (input: EntityListParams<E>) => {
      const firstPage = firstPageOf(input);
      const parsed = parseEntityListInput(entity, wireInputFor(firstPage));
      const policy = operation.policy(parsed);
      return infiniteQueryOptions({
        queryKey: infiniteOperationQueryKey(queryKeyFor(parsed)),
        queryFn: async ({
          pageParam,
          signal,
          client,
          queryKey,
        }): Promise<
          | EntityListResultByEntity[E]
          | EntitySelectedListResultByEntity[ListEntity]
        > =>
          (input.fields === undefined ? call : selectedCall)(
            parseEntityListInput(entity, {
              ...parsed,
              pagination: { ...firstPage.pagination, pageIndex: pageParam },
            }),
            signal,
            client.getQueryState(queryKey)?.isInvalidated
              ? "strong"
              : undefined,
          ),
        initialPageParam: 0,
        getNextPageParam: (lastPage) =>
          lastPage.meta.hasNextPage ? lastPage.meta.pageIndex + 1 : undefined,
        meta: policy.meta,
        ...policy.freshness,
      });
    },
    /** Query options shared by SSR loaders and the mounted infinite table. */
    infiniteQueryOptions: (input: EntityListParams<E>) => {
      const firstPage = firstPageOf(input);
      const parsed = parseEntityListInput(entity, wireInputFor(firstPage));
      const policy = operation.policy(parsed);
      return infiniteQueryOptions({
        queryKey: infiniteOperationQueryKey(queryKeyFor(parsed)),
        queryFn: async ({ pageParam, signal, client, queryKey }) =>
          call(
            parseEntityListInput(entity, {
              ...wireInputFor(firstPage),
              pagination: { ...firstPage.pagination, pageIndex: pageParam },
            }),
            signal,
            client.getQueryState(queryKey)?.isInvalidated
              ? "strong"
              : undefined,
          ),
        initialPageParam: 0,
        getNextPageParam: (lastPage) => {
          const { pageIndex, hasNextPage } = lastPage.meta;
          return hasNextPage ? pageIndex + 1 : undefined;
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
