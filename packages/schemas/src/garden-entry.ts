import { z } from "zod";

import { gardenEntryShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
import { generatedGardenEntryFieldSchemas } from "./generated/entity-field-schemas.gardenEntry.gen";
import { displayImagesField } from "./display-images";

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
    // Anchor and `move` entries lock their location/planting/date fields —
    // corrected only through location history, never the entry edit form.
    // See `assertGardenEntryStructure` in `server/repo/garden/index.ts`.
    anchorsPeriod: z.boolean(),
  });
export type GardenEntryOut = z.infer<typeof gardenEntryOut>;
export const gardenEntryListItemOut = gardenEntryOut.extend({
  displayImages: displayImagesField,
});
export const gardenEntryListOut = createPaginatedResponseSchema(
  gardenEntryListItemOut,
);
