import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { defaultPagination } from "~/app/_components/data-table/tableUtils";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
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

const entityListWireInputSchema = (input: unknown) =>
  input as EntityListInputByEntity[ListEntity];

const getEntityListTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(entityListWireInputSchema)
  .handler(
    async ({ data, context }) =>
      await entityRuntime.getEntityList({
        data,
        request: context.startOperation,
      }),
  );

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

const entityListQueryKey = <E extends ListEntity>(
  entity: E,
  input: EntityListParams<E>,
) => [[entity, "list"], { input }] as const;

export const entityListRootKey = <E extends ListEntity>(entity: E) =>
  [[entity, "list"]] as const;

async function getEntityList<E extends ListEntity>(options: {
  data: EntityListInputByEntity[E];
  signal?: AbortSignal;
}): Promise<EntityListResultByEntity[E]> {
  return await observedStartCall({
    operation: "entity.list",
    entity: options.data.entity,
    input: options.data,
    call: async (headers) =>
      parseEntityListResult(
        options.data.entity,
        unwrapStartOperationResult(
          "entity.list",
          await getEntityListTransport({
            data: options.data,
            signal: options.signal,
            headers,
          }),
        ),
      ),
  });
}

export function entityListQueryOptions<E extends ListEntity>(
  entity: E,
  input: EntityListParams<E>,
) {
  return queryOptions({
    queryKey: entityListQueryKey(entity, input),
    meta: {
      transport: "start",
      operation: "entity.list",
      entity,
      observedByTransport: true,
    },
    queryFn: ({ signal }) =>
      getEntityList({
        data: parseEntityListInput(entity, { entity, ...input }),
        signal,
      }),
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
  const base = entityListQueryOptions(entity, firstPage);
  return infiniteQueryOptions({
    queryKey: [...base.queryKey, "__infinite__"] as const,
    queryFn: ({ pageParam, signal }) =>
      getEntityList({
        data: parseEntityListInput(entity, {
          entity,
          ...firstPage,
          pagination: { ...firstPage.pagination, pageIndex: pageParam },
        }),
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const { pageIndex, pageSize, totalCount } = lastPage.meta;
      return (pageIndex + 1) * pageSize < totalCount
        ? pageIndex + 1
        : undefined;
    },
    meta: base.meta,
  });
}
