import { listGroupByDimensionsSchema } from "@cubby/schemas/pagination";
import { z } from "zod";

import { PIVOT_SHARES } from "./pivot/pivot-model";

const groupingSearchSchema = z.object({
  groupBy: listGroupByDimensionsSchema.optional(),
});

/** The generated route schema validates dimensions; reuse its wire shape here. */
export const listGroupBy = (search: unknown) =>
  groupingSearchSchema.safeParse(search).data?.groupBy;

/**
 * The built-in Pivot view's `?view=` id. It is not a declared view: the URL
 * generator offers it on every list with two groupable choices.
 */
export const PIVOT_VIEW_ID = "pivot";

/** Two distinct groupable choices make a cross-tab; mirrors the generator. */
export const pivotAvailable = (
  grouping: readonly { reason: string | null }[],
) => grouping.filter(({ reason }) => reason === null).length >= 2;

const shareSearchSchema = z.object({
  share: z.enum(PIVOT_SHARES).optional().catch(undefined),
});

/** The Pivot cell share from the URL; Row % when absent. */
export const pivotShare = (search: unknown) =>
  shareSearchSchema.safeParse(search).data?.share ?? "row";
