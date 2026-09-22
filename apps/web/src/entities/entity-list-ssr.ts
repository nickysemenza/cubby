import type { QueryClient } from "@tanstack/react-query";

import { defaultSortDirectionFor, defaultSortFor } from "./entities";
import { compileEntityListInput, entityListFor } from "./entity-list.functions";
import type { FilterPatch } from "./filters";
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
  const query = entityListFor(options.entity).infiniteQueryOptions(
    compileEntityListInput(options.entity, options.search, {
      defaultSort,
    }),
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

/** Mirrors `useEntityListPresentation`'s opening table-state sort. */
export function entityListDefaultSort<E extends ListEntity>(entity: E) {
  return {
    orderBy: defaultSortFor(entity),
    direction: defaultSortDirectionFor(entity),
  };
}
