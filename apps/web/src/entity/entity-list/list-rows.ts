import type { Entity } from "@cubby/schemas/entity";
import { type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { identitySecondLineFields } from "~/entity/display/entity-display";
import type { RowLines } from "~/ui/data-table/density";

const rowsSearchSchema = z.object({
  rowLines: z.coerce.number().pipe(z.literal(2)).optional().catch(undefined),
});

/** Whether a list can draw two-line rows: it declares a second line. */
export const listHasSecondLine = (queryClient: QueryClient, entity: Entity) =>
  identitySecondLineFields(queryClient, entity).length > 0;

/**
 * A list's row lines: single by default; two lines when the URL asks
 * (`rowLines=2`) and the entity declares a second line.
 */
export function listRowLines(
  queryClient: QueryClient,
  entity: Entity,
  search: unknown,
): RowLines {
  return rowsSearchSchema.safeParse(search).data?.rowLines === 2 &&
    listHasSecondLine(queryClient, entity)
    ? "double"
    : "single";
}
