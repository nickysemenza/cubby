import type { QueryClient } from "@tanstack/react-query";
import { browserEntityDefinition } from "./entities";
import {
  compileEntityListInput,
  entityInfiniteListQueryOptions,
} from "./entity-list.functions";
import type { ListEntity } from "./generated/entity-lists.gen";

/**
 * Hydrate exactly the first generic-list page when its route-primary renderer
 * is active. Embedded tables intentionally do not call this helper.
 */
export async function ensureEntityListSsr<E extends ListEntity>(options: {
  queryClient: QueryClient;
  entity: E;
  search: Record<string, unknown>;
  active?: boolean;
}) {
  if (options.active === false) return;
  const defaultSort = entityListDefaultSort(options.entity);
  const query = entityInfiniteListQueryOptions(
    options.entity,
    compileEntityListInput(options.entity, options.search, {
      defaultSort,
    }),
  );
  // A direct request SSRs the page; client navigation starts the identical
  // query without holding the route transition. The mounted list consumes the
  // same cache key in either case.
  if (!import.meta.env.SSR) {
    void options.queryClient.ensureInfiniteQueryData(query);
    return;
  }
  await options.queryClient.ensureInfiniteQueryData(query);
}

/** Mirrors `useEntityListPresentation`'s opening table-state sort. */
export function entityListDefaultSort<E extends ListEntity>(
  entity: E,
): {
  orderBy: string;
  direction: "asc" | "desc";
} {
  const list = browserEntityDefinition(entity).list;
  return {
    orderBy: list?.defaultSort ?? "createdAt",
    direction: list?.defaultSortDirection ?? "desc",
  };
}
