import { z } from "zod";
import { dbTimestampsOut, ndb, upc } from "./util";
import { unitMappingInput } from "./unitmapping";

// Base schema for product data (without relationships)
export const productBase = z.object({
  name: z.string(),
  upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  manufacturer: z.string(),
  model: z.string().nullable(),
});

// Input payload for creating/updating products (includes relationships)
export const productInputPayload = productBase.extend({
  ingredientId: z.string().uuid().nullable(),
  unitMappings: z.array(unitMappingInput).optional(),
});

// Response schema for product data
export const productTopLevelOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(productBase)
  .merge(dbTimestampsOut);

export type ProductTopLevelOut = z.infer<typeof productTopLevelOut>;
export type ProductInputPayload = z.infer<typeof productInputPayload>;
