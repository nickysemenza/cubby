import { productCategoryValues, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { ndb, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { externalIdInput, externalIdOut } from "./external-id";
import {
  ingredientId,
  type IngredientId,
  productId,
  productShortcode,
} from "./identifiers";
import { imageOut, updateInputImages } from "./image";
import { unitMappingInput } from "./unitmapping";

// Product category enum for filtering/organization
export const productCategory = z.enum(productCategoryValues);

export type ProductCategory = z.infer<typeof productCategory>;

// Re-export for consumers that need the values array
export { productCategoryValues } from "@cubby/shared";

/**
 * Check if a product has USDA food data indicators that should force category to "food"
 *
 * A product is considered to have food data if it has:
 * - A valid NDB number (USDA National Nutrient Database)
 * - An associated ingredient (used in recipes)
 *
 * Note: UPC is intentionally NOT included - barcodes are on all products, not just food
 */
export const hasFoodIndicators = (product: {
  ndb_number?: number | null;
  ingredientId?: IngredientId | null;
}): boolean =>
  (product.ndb_number != null && product.ndb_number > 0) ||
  (product.ingredientId != null && product.ingredientId.length > 0);

// Base schema for product data (without relationships)
const productBase = z.object({
  name: z.string(),
  upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  manufacturer: z.string().describe("Manufacturer or 'generic'"),
  model: z.string().nullish().describe("model number"),
  notes: z.string().nullish().describe("product notes, URLs, or other details"),
  expectedQuantity: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("null means unlimited, 1 for unique items"),
  category: productCategory
    .nullable()
    .describe("product category for filtering"),
});

// Input schema for creating products (includes relationships)
// Note: category is optional in input (defaults to null) but required in output
export const productCreateInput = productBase
  .omit({ category: true })
  .extend({
    category: productCategory.nullable().optional(),
    ingredientId: ingredientId.nullable(),
    price: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe("price per each ($), source of truth"),
    unitMappings: z.array(unitMappingInput).default([]),
    externalIds: z.array(externalIdInput).default([]),
    usdaUnavailable: z
      .boolean()
      .nullable()
      .optional()
      .describe("no USDA food exists — expect manual weight/volume/calories"),
  })
  .merge(updateInputImages);

// Input schema for updating products (matches location/recipe/ingredient pattern)
export const productUpdateInput = z.object({
  id: productId,
  data: productCreateInput.partial(),
});

// Response schema for product data
export const productTopLevelOut = z
  .object({
    id: productId,
    shortcode: productShortcode,
    images: z.array(imageOut).default([]),
    externalIds: z.array(externalIdOut).default([]),
    price: z.number().nullable(), // Price per each ($); source of truth (the 1 each -> $X costing edge is synthesized from this at compute time)
    usdaUnavailable: z.boolean().nullable(),
  })
  .extend(productBase.shape)
  .extend(dbTimestampsOut.shape);

export type ProductTopLevelOut = z.infer<typeof productTopLevelOut>;
export type ProductCreateInput = z.infer<typeof productCreateInput>;
export type ProductUpdateInput = z.infer<typeof productUpdateInput>;

// Quick create schema - minimal required fields for rapid entry
// Used for quick inventory capture workflow
export const productQuickCreatePayload = z.object({
  name: z.string().min(1),
  manufacturer: z.string().default(UNSPECIFIED_MANUFACTURER),
  upc: upc.nullable().optional(),
  expectedQuantity: z.number().int().positive().nullable().optional(),
  model: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  price: z.number().positive().nullable().optional(),
});
