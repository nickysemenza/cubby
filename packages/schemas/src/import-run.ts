import { z } from "zod";

import {
  generatedRunFieldSchemas,
  generatedRunFilterFields,
} from "./generated/entity-field-schemas.importRun.gen";
import { generatedEntitySort } from "./generated/entity-sort.gen";
import {
  createPaginatedResponseSchema,
  createSortPaginationFields,
} from "./pagination";

export const importRunOut = z.object(generatedRunFieldSchemas.read);
export type ImportRunOut = z.infer<typeof importRunOut>;
export const importRunListResponse =
  createPaginatedResponseSchema(importRunOut);
export const importRunFilterFields = {
  ...generatedRunFilterFields,
};
export const importRunFilters = z.object(importRunFilterFields);
export type ImportRunFilters = z.infer<typeof importRunFilters>;

/**
 * The web Runs list read. A Run has no create/update contract, so it sits
 * outside the kernel list roster and its generated index reads this instead.
 */
export const importRunBrowserListInput = z.object({
  filters: importRunFilters,
  ...createSortPaginationFields({
    sortableFields: generatedEntitySort.importRun.fields,
    defaultSort: generatedEntitySort.importRun.default,
  }),
});
