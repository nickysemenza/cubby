import type { ListNesting } from "@cubby/schemas/pagination";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { z } from "zod";

import { entityList } from "~/integrations/tanstack-query/generated/catalog.gen";
import {
  infiniteOperationQueryKey,
  type OperationQueryKey,
} from "~/integrations/tanstack-query/operation-catalog";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import { defaultPagination } from "~/ui/data-table/tableUtils";

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
import type { ListEnrichmentGroup, ListReadRow } from "./list-read-fields";

export type EntityListParams<E extends ListEntity> =
  EntityListParamsByEntity[E];
interface CompileEntityListOptions {
  pageSize?: number;
  defaultSort?: { orderBy: string; direction: "asc" | "desc" };
  groupBy?: string;
  /** A nested table's root scope (`listNested`). */
  nesting?: ListNesting;
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
  const searching = Boolean(validatedSearch.searchQuery);
  const input: EntityListParseInput = {
    entity,
    filters: buildFiltersFromManifest(
      getEntityFilters(entity),
      filterGetterFromSearch(getEntityFilters(entity), validatedSearch),
    ),
    pagination: {
      pageIndex: 0,
      pageSize: options.pageSize ?? defaultPagination.pageSize,
    },
  };
  // Omitted rather than an empty array: server list search recognizes the
  // absence of a user sort and opens in lexical relevance order. A URL sort
  // remains authoritative, including the entity's ordinary default when a
  // person selected it deliberately.
  if (parsedSort) input.sort = parsedSort;
  else if (!searching) {
    input.sort = [
      options.defaultSort ?? { orderBy: "createdAt", direction: "desc" },
    ];
  }
  if (options.groupBy) input.groupBy = options.groupBy;
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

/** Partial standard rows use the generated base schema, never the full parser. */
export function entityListBaseFor<E extends ListEntity>(entity: E) {
  const base = entityList.listBase.forEntity(entity);
  const enrichment = entityList.listEnrichment.forEntity(entity);
  const summary = entityList.listSummary.forEntity(entity);
  const inputFor = (input: EntityListParams<E>) =>
    parseEntityListInput(entity, entityListInputFor(entity, input));
  const listQueryPlan = (input: EntityListParams<E>) => {
    const parsed = inputFor(input);
    const options = base.queryOptions(parsed);
    return {
      queryKey: options.queryKey,
      meta: options.meta,
      execute: async (signal: AbortSignal) => {
        const result = await base.call(parsed, { signal });
        return {
          items: result.data,
          meta: result.meta,
          deferredGroups: result.groups,
        };
      },
      progressive: {
        enrich: (
          ids: string[],
          groups: import("~/ui/hooks/progressive-list").ListReadGroup[],
          signal: AbortSignal,
        ) => enrichment.call({ entity, ids, groups }, { signal }),
        summary: async (signal: AbortSignal) => {
          const { sums, totalLabels } = await summary.call(parsed, { signal });
          return { sums, totalLabels };
        },
      },
    };
  };
  const baseInfiniteQueryOptions = (input: EntityListParams<E>) => {
    const firstPage = {
      ...input,
      pagination: { ...input.pagination, pageIndex: 0 },
    };
    const plan = listQueryPlan(firstPage);
    return infiniteQueryOptions({
      queryKey: infiniteOperationQueryKey(plan.queryKey),
      meta: plan.meta,
      ...base.policy(inputFor(firstPage)).freshness,
      queryFn: ({ pageParam, signal }) =>
        listQueryPlan({
          ...firstPage,
          pagination: { ...firstPage.pagination, pageIndex: pageParam },
        }).execute(signal),
      initialPageParam: 0,
      getNextPageParam: (lastPage) => {
        const { pageIndex, pageSize, totalCount } = lastPage.meta;
        return (pageIndex + 1) * pageSize < totalCount
          ? pageIndex + 1
          : undefined;
      },
    });
  };
  return {
    listQueryPlan,
    infiniteQueryOptions: baseInfiniteQueryOptions,
    /** Complete vocabularies need their declared fields, not full media/quality hydration.
     * Base page size and the enrichment schema's ID cap must stay aligned:
     * each page is completed by one enrichment call. */
    projectedInfiniteQueryOptions: <Schema extends z.ZodObject>(
      input: EntityListParams<E>,
      groups: readonly ListEnrichmentGroup[],
      schema: Schema,
    ) => {
      const selected = [...new Set(groups)].sort();
      const firstPage = {
        ...input,
        pagination: { ...input.pagination, pageIndex: 0 },
      };
      const firstPlan = listQueryPlan(firstPage);
      const baseKey = firstPlan.queryKey;
      const payload = {
        ...baseKey[2],
        projection: {
          groups: selected,
          fields: Object.keys(schema.shape).sort(),
        },
      };
      type BasePage = Awaited<ReturnType<typeof firstPlan.execute>>;
      type ProjectedPage = Omit<BasePage, "items"> & {
        items: z.output<Schema>[];
      };
      const parsePage = (
        page: Omit<BasePage, "items"> & { items: ListReadRow[] },
      ): ProjectedPage => ({
        ...page,
        items: schema.array().parse(page.items),
      });
      return infiniteQueryOptions({
        queryKey: infiniteOperationQueryKey([baseKey[0], baseKey[1], payload]),
        meta: firstPlan.meta,
        ...base.policy(inputFor(firstPage)).freshness,
        initialPageParam: 0,
        getNextPageParam: (lastPage: ProjectedPage) => {
          const { pageIndex, pageSize, totalCount } = lastPage.meta;
          return (pageIndex + 1) * pageSize < totalCount
            ? pageIndex + 1
            : undefined;
        },
        queryFn: async ({ pageParam, signal }): Promise<ProjectedPage> => {
          const plan = listQueryPlan({
            ...firstPage,
            pagination: { ...firstPage.pagination, pageIndex: pageParam },
          });
          const page = await plan.execute(signal);
          const requested = selected.filter((id) =>
            page.deferredGroups.some((group) => group.id === id),
          );
          if (page.items.length === 0 || requested.length === 0)
            return parsePage(page);
          const response = await plan.progressive.enrich(
            page.items.map((row) => row.id),
            requested,
            signal,
          );
          const patches = new Map<string, ListReadRow>();
          for (const id of requested) {
            const group = response.groups.find((entry) => entry.id === id);
            if (!group) throw new Error(`No ${id} enrichment returned`);
            if (group.state === "error")
              throw new StartOperationError(group.error);
            for (const row of group.data)
              patches.set(row.id, { ...patches.get(row.id), ...row });
          }
          const missing = new Set(response.missingIds);
          return parsePage({
            ...page,
            items: page.items
              .filter((row) => !missing.has(row.id))
              .map((row) => ({ ...row, ...patches.get(row.id) })),
          });
        },
      });
    },
  };
}
