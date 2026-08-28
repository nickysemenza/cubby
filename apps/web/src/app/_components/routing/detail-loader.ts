import type {
  EnsureQueryDataOptions,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";

/**
 * Prefetch a `$shortcode` route's record, and 404 on an unknown code.
 *
 * ⚠️ `loader` is deliberately NOT in the router plugin's split groupings — it
 * has to run before the route's chunk loads, which is the whole point of a
 * prefetching loader. So everything reachable from here is eager, and this
 * module stays React-free on purpose. Page bodies belong in `./entity-routes`,
 * which no unsplittable route property may reference.
 */
export async function ensureDetailRecord<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<void> {
  const record = await queryClient.ensureQueryData(options);
  if (!record) throw notFound();
}
