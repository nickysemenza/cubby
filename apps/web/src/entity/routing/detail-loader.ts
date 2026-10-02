import type {
  EnsureQueryDataOptions,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";

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
  /**
   * The `$shortcode` as requested plus the page's href. A legacy alias
   * (`P-`/`L-`) resolves to the same record; the route then redirects to the
   * canonical code so links, titles and the browser history carry one spelling.
   */
  requested?: { shortcode: string; href: string },
): Promise<void> {
  const record = await queryClient.ensureQueryData(options);
  if (!record) throw notFound();
  if (!requested) return;
  const identified = identifiedRecord.safeParse(record);
  if (identified.success && identified.data.id !== requested.shortcode) {
    throw redirect({
      href: requested.href.replace(requested.shortcode, identified.data.id),
      replace: true,
    });
  }
}

const identifiedRecord = z.object({ id: z.string() });
