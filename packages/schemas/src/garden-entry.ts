import { z } from "zod";

import { gardenEntryShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
import { generatedGardenEntryFieldSchemas } from "./generated/entity-field-schemas.gardenEntry.gen";

export const gardenEntryCreateInput = z.object(
  generatedGardenEntryFieldSchemas.create,
);
export const gardenEntryUpdateData = z.object(
  generatedGardenEntryFieldSchemas.update,
);
export const gardenEntryUpdateInput = z.object({
  id: gardenEntryShortcode,
  data: gardenEntryUpdateData,
});
export const gardenEntryOut = z.object(generatedGardenEntryFieldSchemas.read);
export type GardenEntryOut = z.infer<typeof gardenEntryOut>;
export const gardenEntryListItemOut = gardenEntryOut.extend({});
export const gardenEntryListOut = createPaginatedResponseSchema(
  gardenEntryListItemOut,
);
