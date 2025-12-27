import { ndb, upc } from "@recipehub/usda-schemas";
import { z } from "zod";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { dbTimestampsOut } from "./common";
import { ingredientId, productId } from "./identifiers";
import { imageOut, updateInputImages } from "./image";
import { unitMappingInput } from "./unitmapping";

// Product category values - single source of truth for both Zod and Drizzle
export const productCategoryValues = [
  "food", // flour, olive oil, canned tomatoes
  "tools", // angle grinder, drill, screwdriver, hand tools
  "tool-consumables", // grinding discs, drill bits, sandpaper
  "tool-accessories", // jigs, fixtures, router table accessories
  "storage", // packout, systainers, toolboxes, bags
  "hardware", // screws, nails, bolts
  "electronics", // raspberry pi, cables, monitors
  "household", // furniture, cookware, appliances
  "supplies", // cleaning products, tape, batteries, cables
] as const;

// Product category enum for filtering/organization
export const productCategory = z.enum(productCategoryValues);

export type ProductCategory = z.infer<typeof productCategory>;

/** Pre-built options for product category select fields */
export const productCategoryOptions = productCategory.options.map((cat) => ({
  value: cat,
  label: cat.replace("-", " "),
}));

// Categories where items are typically consumed/used up
const consumableCategories: ReadonlySet<ProductCategory> = new Set([
  "food",
  "tool-consumables",
  "hardware",
  "supplies",
]);

/** Check if a category represents consumable items */
export const isConsumableCategory = (cat: ProductCategory): boolean =>
  consumableCategories.has(cat);

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
  ingredientId?: string | null;
}): boolean =>
  (product.ndb_number != null && product.ndb_number > 0) ||
  (product.ingredientId != null && product.ingredientId.length > 0);

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
  category: productCategory
    .nullable()
    .describe("product category for filtering"),
});

// Input payload for creating/updating products (includes relationships)
// Note: category is optional in input (defaults to null) but required in output
export const productInputPayload = productBase
  .omit({ category: true })
  .extend({
    category: productCategory.nullable().optional(),
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
