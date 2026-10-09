import { parseShortcode } from "@cubby/shared/shortcode";
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
 * ⚠️ `loader` splits into its own chunk (`codeSplittingOptions` in
 * `vite.config.ts`), apart from the component chunk, so a navigation fetches
 * it before the page body. This module stays React-free on purpose: page
 * bodies belong in `./list-page` and `./detail-page`, never in a loader's chunk.
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
  // A segment that is not a shortcode at all (a retired route such as
  // `/inventory/session`) is a 404, not a validation error from the query.
  if (requested && !parseShortcode(requested.shortcode)) throw notFound();
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
