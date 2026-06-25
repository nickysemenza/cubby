import { productCategoryValues, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { dbTimestampsOut, requiredName } from "./common";
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
export const productCategory = z
  .enum(productCategoryValues)
  .describe("Product category");

export type ProductCategory = z.infer<typeof productCategory>;

// Re-export for consumers that need the values array
export { productCategoryValues } from "@cubby/shared";

/**
 * The explicit USDA food link: a positive `fdc_id`. One definition shared by
 * {@link hasFoodIndicators} and the problems repo's food-category detector, so
 * "what counts as an fdc link" can't drift between them.
 */
export const hasFdcLink = (fdc_id: number | null | undefined): boolean =>
  fdc_id != null && fdc_id > 0;

/**
 * Check if a product has USDA food data indicators that should force category to "food"
 *
 * A product is considered to have food data if it has:
 * - A USDA food link (`fdc_id`)
 * - An associated ingredient (used in recipes)
 *
 * Note: UPC is intentionally NOT included - barcodes are on all products, not just food
 */
export const hasFoodIndicators = (product: {
  fdc_id?: number | null;
  ingredientId?: IngredientId | null;
}): boolean =>
  hasFdcLink(product.fdc_id) ||
  (product.ingredientId != null && product.ingredientId.length > 0);

// Base schema for product data (without relationships)
const productBase = z.object({
  // `mock` is a faker dot-path read by the test mock generator (faker-free here).
  name: z
    .string()
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  upc: upc.nullable(),
  // Explicit USDA link by FoodData Central id (the universal PK across all food
  // types — see `fdcId`). Resolution prefers this over UPC auto-matching.
  // Defaults to null so product summaries from queries that don't select it
  // (inventory / ingredient embeds) validate instead of 500ing, and inputs may
  // omit it.
  fdc_id: fdcId
    .nullable()
    .default(null)
    .describe(
      "USDA FoodData Central id — links the product to any USDA food (takes precedence over the product's UPC). null to unlink.",
    ),
  manufacturer: z
    .string()
    .describe("Manufacturer or 'generic'")
    .meta({ mock: "company.name" }),
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
    // Override the base `name` (lax for reads) with a non-empty constraint on
    // the create/update boundary; keep the mock hint for test fixtures.
    name: requiredName("Product name")
      .describe("Product name")
      .meta({ mock: "commerce.productName" }),
    category: productCategory.nullable().optional(),
    ingredientId: ingredientId
      .nullable()
      .describe(
        "Link this product to an ingredient (its id) so recipes using that ingredient can cost from this product.",
      ),
    price: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe("price per each ($), source of truth"),
    unitMappings: z
      .array(unitMappingInput)
      .default([])
      .describe(
        'Conversion/price edges, e.g. 8 oz = $10 → [{ a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }]. For a weight-measured ingredient an oz/g → dollar edge is the cost basis.',
      ),
    externalIds: z.array(externalIdInput).default([]),
    usdaUnavailable: z
      .boolean()
      .nullable()
      .optional()
      .describe("no USDA food exists — expect manual weight/volume/calories"),
  })
  .merge(updateInputImages);

// A partial update must leave omitted fields UNCHANGED. `.partial()` keeps the
// create-time `.default()`s, so an omitted `fdc_id` (default null) or
// `unitMappings`/`externalIds` (default []) would be reset on any partial update
// — e.g. adding one conversion to an already-USDA-linked product nulled its
// fdc_id (audit: 171287 → null, 2026-06-19). Override those fields to plain
// optional (no default) so omitting them is a true no-op.
export const productUpdateData = productCreateInput.partial().extend({
  fdc_id: fdcId.nullable().optional(),
  unitMappings: z.array(unitMappingInput).optional(),
  externalIds: z.array(externalIdInput).optional(),
});

// Input schema for updating products (matches location/recipe/ingredient pattern)
export const productUpdateInput = z.object({
  id: productId,
  data: productUpdateData,
});

// Filters accepted by the product list endpoint. Canonical shape shared by the
// tRPC router (and available to any other list caller).
export const productFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  manufacturerFilter: z.string().optional(),
  upcFilter: z.string().optional(),
  categoryFilter: productCategory.optional(),
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
