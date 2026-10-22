import { listGroupByDimensionsSchema } from "@cubby/schemas/pagination";
import { z } from "zod";

const groupingSearchSchema = z.object({
  groupBy: listGroupByDimensionsSchema.optional(),
});

/** The generated route schema validates dimensions; reuse its wire shape here. */
export const listGroupBy = (search: unknown) =>
  groupingSearchSchema.safeParse(search).data?.groupBy;
