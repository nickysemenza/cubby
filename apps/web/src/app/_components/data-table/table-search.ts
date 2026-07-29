import { z } from "zod";
import { urlStringParam } from "~/lib/search-params";

/**
 * Search-param keys that useTableState mirrors to the URL (urlSync). A list
 * route whose `validateSearch` is a strict `z.object` must merge this fragment
 * (`...tableSearchFields`) so these keys survive navigation —
 * otherwise validateSearch strips them. Routes with no `validateSearch` already
 * pass arbitrary search params through, so they need nothing.
 *
 * `.catch(undefined)` keeps a malformed value from throwing the whole route.
 * `sort` is a {@link urlStringParam} rather than a bare `z.string()` for the
 * reason documented there — `page`/`pageSize` are genuinely numeric and stay
 * `z.coerce.number()`.
 */
export const tableSearchFields = {
  sort: urlStringParam,
  page: z.coerce.number().int().positive().optional().catch(undefined),
  pageSize: z.coerce.number().int().positive().optional().catch(undefined),
};
