import { z } from "zod";
import { dbTimestampsOut, ndb, upc } from "./util";
import { imageOut, updateInputImages } from "./image";
import { unitMappingInput } from "./unitmapping";

// Base schema for product data (without relationships)
export const productBase = z.object({
  name: z.string(),
  upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  manufacturer: z.string().describe("Manufacturer or 'generic'"),
  model: z.string().nullable().describe("model number"),
});

// Input payload for creating/updating products (includes relationships)
export const productInputPayload = productBase
  .extend({
    ingredientId: z.string().uuid().nullable(),
    unitMappings: z.array(unitMappingInput).optional(),
  })
  .merge(updateInputImages);

// Response schema for product data
export const productTopLevelOut = z
  .object({
    id: z.string().uuid(),
    images: z.array(imageOut).optional(),
  })
  .merge(productBase)
  .merge(dbTimestampsOut);

export type ProductTopLevelOut = z.infer<typeof productTopLevelOut>;
export type ProductInputPayload = z.infer<typeof productInputPayload>;
