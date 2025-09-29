import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { upc, ndb } from "@recipehub/usda-schemas";
import { imageOut, updateInputImages } from "./image";
import { unitMappingInput } from "./unitmapping";
import { productId, ingredientId } from "./identifiers";

// Base schema for product data (without relationships)
const productBase = z.object({
  name: z.string(),
  upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  manufacturer: z.string().describe("Manufacturer or 'generic'"),
  model: z.string().nullable().describe("model number"),
  expectedQuantity: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("null means unlimited, 1 for unique items"),
});

// Input payload for creating/updating products (includes relationships)
export const productInputPayload = productBase
  .extend({
    ingredientId: ingredientId.nullable(),
    unitMappings: z.array(unitMappingInput).optional(),
  })
  .merge(updateInputImages);

// Response schema for product data
export const productTopLevelOut = z
  .object({
    id: productId,
    images: z.array(imageOut).optional(),
  })
  .extend(productBase.shape)
  .extend(dbTimestampsOut.shape);

export type ProductTopLevelOut = z.infer<typeof productTopLevelOut>;
export type ProductInputPayload = z.infer<typeof productInputPayload>;
