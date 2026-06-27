import { z } from "zod";

/**
 * Search-param keys that useTableState mirrors to the URL (urlSync). A list
 * route whose `validateSearch` is a strict `z.object` must merge this fragment
 * (`...tableSearchFields`) so these keys survive navigation —
 * otherwise validateSearch strips them. Routes with no `validateSearch` already
 * pass arbitrary search params through, so they need nothing.
 *
 * `.catch(undefined)` keeps a malformed value from throwing the whole route.
 */
export const tableSearchFields = {
  sort: z.string().optional().catch(undefined),
  page: z.coerce.number().int().positive().optional().catch(undefined),
  pageSize: z.coerce.number().int().positive().optional().catch(undefined),
};

export const tableSearchSchema = z.object(tableSearchFields);
