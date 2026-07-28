import { productCategoryValues, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { fdcId, foodSummary, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import { amount } from "./codec";
import { requiredName } from "./common";
import { externalIdInput } from "./external-id";
import { externalIdOut } from "./external-id";
import {
  ingredientId,
  normalizedProductShortcode,
  type IngredientId,
  inventoryId,
  productId,
  productShortcode,
} from "./identifiers";
import { imageOut } from "./image";
import { locationListRefOut, locationOut } from "./location";
import { createPaginatedResponseSchema, presenceFilter } from "./pagination";
import { baseKind } from "./problems";
import { recipeUsageOut } from "./recipe";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  mcpUnitMappingOut,
  unitMappingInput,
  unitMappingOut,
  unitMappingWithMetadata,
} from "./unitmapping";

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
const productCreateShape = {
  // Override the output/read `name` (lax for reads) with a non-empty constraint on
  // the create/update boundary; keep the mock hint for test fixtures.
  name: requiredName("Product name")
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  aliases: z
    .array(z.string())
    .default([])
    .describe(
      "Alternate names for this product — searched alongside the name. Replaces the existing list when provided.",
    ),
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
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      "price per each ($), source of truth. 0 is meaningful and distinct from null: it asserts the item is genuinely free (bundled accessories, freebies), whereas null means nobody has priced it yet — the same convention purchase.cost uses.",
    ),
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
};

export const productCreateInput = z.object(productCreateShape);

// A partial update makes every create field optional and — critically — strips
// the create-time `.default([])` off `unitMappings`/`externalIds` so omitting
// them leaves the existing rows UNCHANGED (see deriveUpdateData). `removeImageIds`
// is update-only.
export const productUpdateData = deriveUpdateData(productCreateShape, {
  extend: {
    removeImageIds: z.array(z.uuid()).optional(),
    imageOrder: z
      .array(z.uuid())
      .optional()
      .describe("existing image ids in display order; first = cover"),
  },
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
  shortcodes: z.array(normalizedProductShortcode),
});

export const productShortcodeInput = z.object({
  shortcode: normalizedProductShortcode,
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
export const productFilterFields = {
  nameFilter: z.string().optional().describe("Filter by product name"),
  manufacturerFilter: z.string().optional().describe("Filter by manufacturer"),
  upcFilter: z.string().optional().describe("Filter by UPC code"),
  categoryFilter: productCategory.optional().describe("Filter by category"),
  inventoryPresenceFilter: presenceFilter,
  ingredientPresenceFilter: presenceFilter,
};

export const productFiltersSchema = z.object(productFilterFields);

export const productSortableFields = [
  "createdAt",
  "name",
  "manufacturer",
  "model",
  "upc",
  "category",
  "fdc_id",
  "price",
  "notes",
  "location",
  "unitMappingQuality",
  "ingredient",
] as const;

export type ProductSortField = (typeof productSortableFields)[number];

export const productUnitMappingQuality = z.enum([
  "none",
  "partial",
  "good",
  "complete",
]);
export type ProductUnitMappingQuality = z.infer<
  typeof productUnitMappingQuality
>;

const productTopLevelFields = {
  id: productId,
  shortcode: productShortcode,
  name: z
    .string()
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  aliases: z
    .array(z.string())
    .default([])
    .describe("Alternate names for this product (searched + embedded)"),
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
  model: z.string().nullable().describe("model number"),
  notes: z
    .string()
    .nullable()
    .describe("product notes, URLs, or other details"),
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
  ...timestampedFields,
};

// Response schema for product data
export const productTopLevelOut = z.object(productTopLevelFields);

/**
 * find-or-create result: the product plus whether it was newly created (vs a
 * match against an existing product). The scan UI prompts to link an ingredient
 * only when `created` — a brand-new UPC product lands with no ingredient link.
 */
export const productFindOrCreateByUPCOut = z.object({
  product: productTopLevelOut,
  created: z.boolean(),
});

export type ProductTopLevelOut = z.infer<typeof productTopLevelOut>;
export type ProductFindOrCreateByUPCOut = z.infer<
  typeof productFindOrCreateByUPCOut
>;
export type ProductCreateInput = z.infer<typeof productCreateInput>;
export type ProductUpdateInput = z.infer<typeof productUpdateInput>;

const productIngredientOut = z.object({
  id: ingredientId,
  name: z.string().meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
  naKinds: z.array(baseKind),
  ...timestampedFields,
});

const productInventoryFields = {
  id: inventoryId,
  amount,
  valuation: z.number().nullable(),
  // Last deliberate recount (null = never). `updatedAt` moves on any write —
  // including a price-driven valuation recompute — so it can't stand in for
  // "when was this count last confirmed".
  verifiedAt: z.date().nullable(),
  ...timestampedFields,
};

const productInventoryWithLocationOut = z.object({
  ...productInventoryFields,
  location: locationOut,
});

export const productWithMappingsOut = z.object({
  ...productTopLevelFields,
  unitMappings: z.array(unitMappingOut),
});
export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

export const productWithMappingsAndFoodOut = z.object({
  ...productTopLevelFields,
  unitMappings: z.array(unitMappingOut),
  food: foodSummary.nullable(),
});
export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;

export const productPickerItemOut = z.object({
  id: productId,
  shortcode: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
});
export type ProductPickerItemOut = z.infer<typeof productPickerItemOut>;

export const productWithIngredientAndInventoryAndMappingsOut = z.object({
  ...productTopLevelFields,
  ingredient: productIngredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(productInventoryWithLocationOut),
});

export const productListInventoryEntryOut = z.object({
  ...productInventoryFields,
  location: locationListRefOut,
});

// Product list rows stay list-shaped. USDA summaries and recipe usages hydrate
// through separate/detail paths so list paint is not blocked by ancillary data.
export const productListItemOut = z.object({
  ...productTopLevelFields,
  unitMappings: z.array(unitMappingOut),
  ingredient: productIngredientOut.nullable(),
  inventoryEntry: z.array(productListInventoryEntryOut),
  unitMappingQuality: productUnitMappingQuality,
});
export type ProductListItem = z.infer<typeof productListItemOut>;

// Enriched product shape for detail/create/update responses. recipeUsages is
// required here because this schema represents a fully hydrated product detail
// response, not list rows or lazy-loaded recipe usage data.
export const productWithFoodOut = z.object({
  ...productTopLevelFields,
  ingredient: productIngredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(productInventoryWithLocationOut),
  food: foodSummary.nullable(),
  recipeUsages: z.array(recipeUsageOut),
});
export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

export const productWithFoodAndSideEffectsOut = z.object({
  ...productTopLevelFields,
  ingredient: productIngredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(productInventoryWithLocationOut),
  food: foodSummary.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  sideEffects: mutationSideEffectsSchema,
});
export type ProductWithFoodAndSideEffectsOut = z.infer<
  typeof productWithFoodAndSideEffectsOut
>;

export const productFoodSummariesOut = z.record(
  z.string(),
  foodSummary.nullable(),
);

export const productImageSummariesOut = z.record(z.string(), z.array(imageOut));

export const productUnitMappingSummariesOut = z.record(
  z.string(),
  z.array(unitMappingWithMetadata),
);

export const productSummaryInclude = z.enum(["food", "images", "unitMappings"]);
export type ProductSummaryInclude = z.infer<typeof productSummaryInclude>;

export const productSummariesInput = z.object({
  ids: z.array(productId).max(500),
  include: z.array(productSummaryInclude).min(1),
});
export type ProductSummariesInput = z.infer<typeof productSummariesInput>;

export const productSummariesOut = z.object({
  food: productFoodSummariesOut.optional(),
  images: productImageSummariesOut.optional(),
  unitMappings: productUnitMappingSummariesOut.optional(),
});
export type ProductSummariesOut = z.infer<typeof productSummariesOut>;

export const productShortcodeListOut = z.array(productTopLevelOut);

export const productCategoryDistributionOut = z.array(
  z.object({
    category: productCategory.nullable(),
    productCount: z.number().int().nonnegative(),
    locations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
);

// Quick create schema - minimal required fields for rapid entry
// Used for quick inventory capture workflow
export const productQuickCreatePayload = z.object({
  name: requiredName("Product name"),
  manufacturer: z.string().default(UNSPECIFIED_MANUFACTURER),
  upc: upc.nullable().optional(),
  expectedQuantity: z.number().int().positive().nullable().optional(),
  model: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  category: productCategory.nullable().optional(),
});

export type ProductQuickCreatePayload = z.infer<
  typeof productQuickCreatePayload
>;

export const mcpProductCreateInput = z.object({
  name: requiredName("Product name")
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  upc: upc.nullable(),
  manufacturer: z
    .string()
    .describe("Manufacturer or 'generic'")
    .meta({ mock: "company.name" }),
  ingredientId: ingredientId
    .nullable()
    .describe(
      "Link this product to an ingredient (its id) so recipes using that ingredient can cost from this product.",
    ),
  price: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      "price per each ($), source of truth. 0 is meaningful and distinct from null: it asserts the item is genuinely free (bundled accessories, freebies), whereas null means nobody has priced it yet — the same convention purchase.cost uses.",
    ),
  unitMappings: z
    .array(unitMappingInput)
    .default([])
    .describe(
      'Conversion/price edges, e.g. 8 oz = $10 → [{ a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }]. For a weight-measured ingredient an oz/g → dollar edge is the cost basis.',
    ),
  usdaUnavailable: z
    .boolean()
    .nullable()
    .optional()
    .describe("no USDA food exists — expect manual weight/volume/calories"),
});

export const mcpProductUpdateInput = z.object({
  name: requiredName("Product name")
    .describe("Product name")
    .meta({ mock: "commerce.productName" })
    .optional(),
  // Not inherited from productCreateShape (this MCP shape is hand-written), so
  // aliases has to be listed explicitly to be editable by the agent.
  aliases: z
    .array(z.string())
    .optional()
    .describe("Alternate names (replaces the existing list)"),
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
  price: z.number().nonnegative().nullable().optional(),
  usdaUnavailable: z.boolean().nullable().optional(),
});

/** Slim MCP projection of a product list/detail row. */
export const productMcpOut = z.object({
  id: productId,
  name: z.string(),
  shortcode: productShortcode,
  manufacturer: z.string(),
  upc: upc.nullable(),
  category: productCategory.nullable(),
  price: z.number().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  fdc_id: fdcId.nullable(),
  usdaUnavailable: z.boolean().nullable(),
  externalIds: z.array(externalIdOut),
  usdaFdcId: z.number().nullable(),
  ingredientId: z.string().nullable(),
  unitMappings: z.array(mcpUnitMappingOut),
});
export type ProductMcpOut = z.infer<typeof productMcpOut>;

export const productMcpListOut = createPaginatedResponseSchema(productMcpOut);
