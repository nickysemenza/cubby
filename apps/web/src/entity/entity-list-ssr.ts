import type { Entity } from "@cubby/schemas/entity";
import { isSlotListView } from "@cubby/schemas/entity-definitions/definition";
import { entityIndex } from "@cubby/schemas/entity-index";
import type { QueryClient } from "@tanstack/react-query";

import {
  compileEntityListInput,
  entityListBaseFor,
} from "~/entity/entity-list";

import { defaultSortDirectionFor, defaultSortFor } from "./entities";
import { resolveListView } from "./entity-list/resolve-list-view";
import { getEntityFilters } from "./filter-manifest";
import {
  decodeFilters,
  encodeFilters,
  filterGetterFromColumnFilters,
  type FilterPatch,
  resolveOpeningFilters,
} from "./filters";
import type { ListEntity } from "./generated/entity-lists.gen";

type EntityListLoaderArgs = {
  context: { queryClient: QueryClient };
  deps: FilterPatch;
  abortController: AbortController;
};

/** Bind the standard eager list loader while leaving route options literal. */
export function entityListLoader<E extends ListEntity>(entity: E) {
  return ({ context, deps, abortController }: EntityListLoaderArgs) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity,
      search: deps,
      // A slot view (Runs history) owns its reads and its URL keys — `sort`
      // there is `newest|oldest`, not a kernel sort field — so the kernel
      // list is not its first page to hydrate.
      active: !isSlotListView(resolveListView(entity, deps).view),
      signal: abortController.signal,
    });
}

/**
 * Hydrate exactly the first generic-list page when its route-primary renderer
 * is active. Embedded tables intentionally do not call this helper.
 */
export async function ensureEntityListSsr<E extends ListEntity>(options: {
  queryClient: QueryClient;
  entity: E;
  search: FilterPatch;
  active?: boolean;
  defaultSort?: { orderBy: string; direction: "asc" | "desc" };
  signal?: AbortSignal;
}) {
  if (options.active === false) return;
  const defaultSort =
    options.defaultSort ?? entityListDefaultSort(options.entity);
  const query = entityListBaseFor(options.entity).infiniteQueryOptions(
    compileEntityListInput(
      options.entity,
      searchWithInitialFilter(options.entity, options.search),
      { defaultSort },
    ),
  );
  const cancelUnobserved = () => {
    const cached = options.queryClient
      .getQueryCache()
      .find({ queryKey: query.queryKey, exact: true });
    if ((cached?.getObserversCount() ?? 0) === 0) {
      void options.queryClient.cancelQueries({
        queryKey: query.queryKey,
        exact: true,
      });
    }
  };
  if (options.signal?.aborted) return;
  options.signal?.addEventListener("abort", cancelUnobserved, { once: true });
  const removeAbortListener = () =>
    options.signal?.removeEventListener("abort", cancelUnobserved);
  const preload = options.queryClient.ensureInfiniteQueryData(query);
  // A direct request SSRs the page; client navigation starts the identical
  // query without holding the route transition. The mounted list consumes the
  // same cache key in either case.
  if (!import.meta.env.SSR) {
    // SILENT: TanStack Query retains the rejection in its cache keyed by
    // `query.queryKey`; the mounted list re-subscribes to the same key and
    // renders the retained error itself, so nothing here needs to surface it.
    void preload.catch(() => {}).finally(removeAbortListener);
    return;
  }
  try {
    await preload;
  } finally {
    removeAbortListener();
  }
}

/**
 * Mirrors `useTableState`'s opening filters: the entity's declared default
 * applies while the URL names no filter and has not recorded clearing it, so
 * the server-rendered page and the hydrating table share one cache key.
 */
export function searchWithInitialFilter(
  entity: Entity,
  search: FilterPatch,
): FilterPatch {
  // The summary carries the same initial filter as the inspector metadata,
  // which is ~350 KB the route loaders would otherwise load on every request.
  const initial = entityIndex[entity].list.initialFilter;
  if (initial.length === 0) return search;
  const specs = getEntityFilters(entity);
  if (
    resolveOpeningFilters(decodeFilters(specs, search), search, initial) !==
    initial
  )
    return search;
  return {
    ...search,
    ...encodeFilters(specs, filterGetterFromColumnFilters<unknown>(initial)),
  };
}

/** Mirrors `useEntityListPresentation`'s opening table-state sort. */
export function entityListDefaultSort<E extends ListEntity>(entity: E) {
  return {
    orderBy: defaultSortFor(entity),
    direction: defaultSortDirectionFor(entity),
  };
}
