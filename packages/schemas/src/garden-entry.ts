import { z } from "zod";

import { gardenEntryShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
import { generatedGardenEntryFieldSchemas } from "./generated/entity-field-schemas.gardenEntry.gen";
import { displayImagesField } from "./image-summary";

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
export const gardenEntryOut = z
  .object(generatedGardenEntryFieldSchemas.read)
  .extend({
    locationName: z.string(),
    plantingName: z.string().nullable(),
  });
export type GardenEntryOut = z.infer<typeof gardenEntryOut>;
export const gardenEntryListItemOut = gardenEntryOut.extend({
  displayImages: displayImagesField,
});
export const gardenEntryListOut = createPaginatedResponseSchema(
  gardenEntryListItemOut,
);
