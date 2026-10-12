import { suggestionReviewListInput } from "@cubby/schemas/ai";
import { z } from "zod";

/** The Review tab's URL filters. Kept apart from the list so the `/ai`
 * route's search validation does not pull the table into the router chunk. */
export const suggestionReviewFiltersSchema = suggestionReviewListInput
  .pick({ entity: true, field: true, kind: true, runId: true, status: true })
  .partial()
  .extend({ minConfidence: z.number().min(0).max(1).optional() });
export type SuggestionReviewFilters = z.infer<
  typeof suggestionReviewFiltersSchema
>;
