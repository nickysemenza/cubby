import { z } from "zod";

import {
  generatedRunFieldSchemas,
  generatedRunFilterFields,
} from "./generated/entity-field-schemas.run.gen";
import { generatedEntitySort } from "./generated/entity-sort.gen";
import {
  createPaginatedResponseSchema,
  createSortPaginationFields,
} from "./pagination";

export const runOut = z.object(generatedRunFieldSchemas.read);
export type RunOut = z.infer<typeof runOut>;
export const runListResponse = createPaginatedResponseSchema(runOut);
export const runFilterFields = {
  ...generatedRunFilterFields,
};
export const runFilters = z.object(runFilterFields);
export type RunFilters = z.infer<typeof runFilters>;

/**
 * The web Runs list read. A Run has no create/update contract, so it sits
 * outside the kernel list roster and its generated index reads this instead.
 */
export const runBrowserListInput = z.object({
  filters: runFilters,
  ...createSortPaginationFields({
    sortableFields: generatedEntitySort.run.fields,
    defaultSort: generatedEntitySort.run.default,
  }),
});
