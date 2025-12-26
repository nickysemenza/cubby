import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { upc, ndb } from "@recipehub/usda-schemas";
import { imageOut, updateInputImages } from "./image";
import { unitMappingInput } from "./unitmapping";
import { productId, ingredientId } from "./identifiers";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";

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
    unitMappings: z.array(unitMappingInput).default([]),
  })
  .merge(updateInputImages);

// Response schema for product data
export const productTopLevelOut = z
  .object({
    id: productId,
    images: z.array(imageOut).default([]),
  })
  .extend(productBase.shape)
  .extend(dbTimestampsOut.shape);

export type ProductTopLevelOut = z.infer<typeof productTopLevelOut>;
export type ProductInputPayload = z.infer<typeof productInputPayload>;

// Quick create schema - minimal required fields for rapid entry
// Used for quick inventory capture workflow
export const productQuickCreatePayload = z.object({
  name: z.string().min(1),
  manufacturer: z.string().default(UNSPECIFIED_MANUFACTURER),
  upc: upc.nullable().optional(),
  expectedQuantity: z.number().int().positive().nullable().optional(),
  model: z.string().nullable().optional(),
  price: z.number().positive().nullable().optional(),
});
