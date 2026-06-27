import { productCategoryValues, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { requiredName } from "./common";
import { externalIdInput } from "./external-id";
import { externalIdOut } from "./external-id-responses";
import {
  ingredientId,
  type IngredientId,
  productId,
  productShortcode,
} from "./identifiers";
import { imageOut } from "./image-responses";
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

// Input schema for creating products (includes relationships)
// Note: category is optional in input (defaults to null) but required in output
export const productCreateInput = z.object({
  // Override the output/read `name` (lax for reads) with a non-empty constraint on
  // the create/update boundary; keep the mock hint for test fixtures.
  name: requiredName("Product name")
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  upc: upc.nullable(),
  fdc_id: fdcId
    .nullable()
    .optional()
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
  pendingImageIds: z.array(z.uuid()).optional(),
});

// A partial update must leave omitted fields UNCHANGED. This schema is explicit
// instead of `productCreateInput.partial()` so create-time defaults never become
// destructive update defaults for `unitMappings`/`externalIds`.
export const productUpdateData = z.object({
  name: requiredName("Product name")
    .describe("Product name")
    .meta({ mock: "commerce.productName" })
    .optional(),
  upc: upc.nullable().optional(),
  fdc_id: fdcId.nullable().optional(),
  manufacturer: z
    .string()
    .describe("Manufacturer or 'generic'")
    .meta({ mock: "company.name" })
    .optional(),
  model: z.string().nullish(),
  notes: z.string().nullish(),
  expectedQuantity: z.number().int().positive().nullable().optional(),
  category: productCategory.nullable().optional(),
  ingredientId: ingredientId.nullable().optional(),
  price: z.number().positive().nullable().optional(),
  unitMappings: z.array(unitMappingInput).optional(),
  externalIds: z.array(externalIdInput).optional(),
  usdaUnavailable: z.boolean().nullable().optional(),
  pendingImageIds: z.array(z.uuid()).optional(),
  removeImageIds: z.array(z.uuid()).optional(),
});

// Input schema for updating products (matches location/recipe/ingredient pattern)
export const productUpdateInput = z.object({
  id: productId,
  data: productUpdateData,
});

// Ancillary product hydration endpoints run through tRPC GET batching. Keep this
// stricter than the general 1000-row backend ceiling so product list hydration
// stays under URL/dispatch limits.
export const PRODUCT_SUMMARY_BATCH_MAX = 50;

export const productSummaryBatchInput = z.object({
  ids: z.array(productId).max(PRODUCT_SUMMARY_BATCH_MAX),
});

export const productApplyUpcInput = z.object({
  id: productId,
  upc,
});

export const productFindOrCreateByUPCInput = z.object({
  upc,
  defaultName: z.string().optional(),
});

export const productShortcodesInput = z.object({
  shortcodes: z.array(z.string()),
});

export const productShortcodeInput = z.object({
  shortcode: z.string(),
});

export const productCreateManyInput = z
  .array(productCreateInput)
  .min(1)
  .max(50);

export const productMarkUsdaUnavailableManyInput = z.object({
  ids: z.array(productId).min(1).max(100),
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
export const productTopLevelOut = z.object({
  id: productId,
  shortcode: productShortcode,
  name: z
    .string()
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  upc: upc.nullable(),
  fdc_id: fdcId
    .nullable()
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
  images: z.array(imageOut),
  externalIds: z.array(externalIdOut),
  price: z.number().nullable(), // Price per each ($); source of truth (the 1 each -> $X costing edge is synthesized from this at compute time)
  usdaUnavailable: z.boolean().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ProductTopLevelOut = z.infer<typeof productTopLevelOut>;
export type ProductCreateInput = z.infer<typeof productCreateInput>;
export type ProductUpdateInput = z.infer<typeof productUpdateInput>;

// Quick create schema - minimal required fields for rapid entry
// Used for quick inventory capture workflow
export const productQuickCreatePayload = z.object({
  name: requiredName("Product name"),
  manufacturer: z.string().default(UNSPECIFIED_MANUFACTURER),
  upc: upc.nullable().optional(),
  expectedQuantity: z.number().int().positive().nullable().optional(),
  model: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  price: z.number().positive().nullable().optional(),
});
