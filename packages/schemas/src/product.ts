import { productCategoryValues, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { fdcId, foodSummary, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { productRelatedFilterFields } from "./related-view";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import {
  dataQuality,
  dataQualityStatus,
  productDataCheck,
} from "./data-quality";
import { amount } from "./codec";
import { requiredName } from "./common";
import { externalIdInput } from "./external-id";
import { externalIdOut } from "./external-id";
import {
  type IngredientId,
  ingredientShortcode,
  inventoryShortcode,
  productShortcode,
} from "./identifiers";
import { imageOut } from "./image";
import { locationListRefOut, locationOut } from "./location";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { baseKind } from "./problems";
import { recipeUsageOut } from "./recipe";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  mcpUnitMappingOut,
  mcpUnitMappingInput,
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
  tags: z
    .array(z.string())
    .default([])
    .describe(
      'Free-form compatibility/grouping tags, e.g. "grinder-4.5in" or "M18". Tag the tool AND the consumables that fit it with the same value; `category` says which side each is. Replaces the existing list when provided.',
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
  ingredientId: ingredientShortcode
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
      "price per each ($), source of truth. 0 is meaningful and distinct from null: it asserts the item is genuinely free (bundled accessories, freebies), whereas null means nobody has priced it yet — the same convention expense.cost uses.",
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
  id: productShortcode,
  data: productUpdateData,
});

// Ancillary product hydration endpoints run through tRPC GET batching. Keep this
// stricter than the general 1000-row backend ceiling so product list hydration
// stays under URL/dispatch limits.
export const PRODUCT_SUMMARY_BATCH_MAX = 50;

export const productSummaryBatchInput = z.object({
  ids: z.array(productShortcode).max(PRODUCT_SUMMARY_BATCH_MAX),
});

export const productApplyUpcInput = z.object({
  id: productShortcode,
  upc,
});

export const productFindOrCreateByUPCInput = z.object({
  upc,
  defaultName: z.string().optional(),
});

export const productShortcodesInput = z.object({
  shortcodes: z.array(productShortcode),
});

export const productShortcodeInput = z.object({
  shortcode: productShortcode,
});

export const productCreateManyInput = z
  .array(productCreateInput)
  .min(1)
  .max(50);

export const productMarkUsdaUnavailableManyInput = z.object({
  ids: z.array(productShortcode).min(1).max(100),
});

// Filters accepted by the product list endpoint. Canonical shape shared by the
// tRPC router (and available to any other list caller).
export const productFilterFields = {
  ...productRelatedFilterFields,
  nameFilter: z.string().optional().describe("Filter by product name"),
  manufacturerFilter: z.string().optional().describe("Filter by manufacturer"),
  upcFilter: z.string().optional().describe("Filter by UPC code"),
  modelFilter: z
    .string()
    .optional()
    .describe(
      "Filter by model number — a tool's real identity when the name is generic.",
    ),
  modelPresenceFilter: presenceFilter,
  externalIdSource: oneOrMany(z.string().min(1)).optional(),
  externalIdPresenceFilter: presenceFilter,
  dataStatus: dataQualityStatus.optional(),
  dataGap: oneOrMany(productDataCheck).optional(),
  categoryFilter: oneOrMany(productCategory)
    .optional()
    .describe("Filter by category"),
  inventoryPresenceFilter: presenceFilter,
  ingredientPresenceFilter: presenceFilter,
  tagFilters: z
    .array(z.string())
    .optional()
    .describe("Match products carrying any of these tags"),
  /**
   * `"none"` is the untagged worklist. Unlike `recipe.tags`, `product.tags` is
   * `notNull` with a `'{}'` default, so empty is the only untagged state —
   * `cardinality(tags) = 0`, no `IS NULL` half. OR-ed with `tagFilters` rather
   * than narrowing it (see `taskFilterFields.projectPresenceFilter`).
   */
  tagsPresenceFilter: presenceFilter,
  /**
   * `product.category` is nullable, so `"none"` is the uncategorized worklist.
   * OR-ed with `categoryFilter` — see `taskFilterFields.projectPresenceFilter`.
   */
  categoryPresenceFilter: presenceFilter,
  expensePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have at least one expense in the ledger. Both acquisitions and exits (negative rows) count.",
  ),
  /**
   * `product.price` is a nullable column on the root table (not a
   * cross-entity id-set subquery like `expensePresenceFilter`/
   * `inventoryPresenceFilter`) — combine with `inventoryPresenceFilter: "has"`
   * for the valuation-gap worklist: products physically in inventory that
   * nobody has priced yet.
   */
  pricePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have a price set.",
  ),
  /**
   * A *key* filter, not a resolution filter. The USDA link is resolved at read
   * time by `foodLookupParamFromProduct` — explicit `fdc_id` first, else the
   * `upc` is auto-matched against USDA branded foods, which may find nothing.
   * SQL can only see whether a key exists. `usdaUnavailable` is deliberately
   * NOT folded in: setting it doesn't clear `fdc_id`/`upc`, so a product can be
   * both "has key" and "confirmed unavailable", and conflating them would make
   * neither recoverable.
   */
  usdaPresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have a USDA lookup key (an explicit fdc_id, or a UPC to auto-match). NOT whether USDA actually resolves a food for that key.",
  ),
  imagePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have at least one image (PDF manuals don't count).",
  ),
  unitMappingPresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have at least one unit mapping (conversion edge).",
  ),
};

export const productFiltersSchema = z.object(productFilterFields);
export type ProductFilters = z.infer<typeof productFiltersSchema>;

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
  "ingredient",
  "expenseTotal",
] as const;

export type ProductSortField = (typeof productSortableFields)[number];

const productTopLevelFields = {
  id: productShortcode,
  name: z
    .string()
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  aliases: z
    .array(z.string())
    .default([])
    .describe("Alternate names for this product (searched + embedded)"),
  tags: z
    .array(z.string())
    .default([])
    .describe(
      'Free-form compatibility/grouping tags, e.g. "grinder-4.5in", "M18"',
    ),
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
  dataQuality,
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
  id: ingredientShortcode,
  name: z.string().meta({ mock: "food.ingredient" }),
  aliases: z.array(z.string()),
  naKinds: z.array(baseKind),
  ...timestampedFields,
});

const productInventoryFields = {
  id: inventoryShortcode,
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
  id: productShortcode,
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
  // Live expenses (acquisitions + negative exit rows) linked to this
  // product — backs the list's "Expenses" column + its deep link to
  // `/expenses?productId=`.
  expenseCount: z.number().int(),
  // Net basis: SUM(expense.cost) over this product's live expenses. Plain sum
  // IS the net basis here — negative rows (refunds, disposals) are real in
  // this ledger, so they telescope correctly. 0 for a product with no
  // expenses, never null.
  expenseTotal: z.number(),
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
  ids: z.array(productShortcode).max(500),
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

/**
 * `product.tagOptions`' output — the distinct tag roster feeding the product
 * list's Tags filter picklist, ranked by how many products carry each tag.
 * Counted (unlike `recipeTagsOut`, a bare string array) so the picklist can
 * show usage and surface near-duplicate tags.
 */
export const productTagOptionsOut = z.array(
  z.object({
    tag: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type ProductTagOptionsOut = z.infer<typeof productTagOptionsOut>;

/**
 * Products sharing a tag with the one being viewed. Each row carries its own
 * full `tags` so the client can group by the shared tag — `category` is what
 * tells you which side of the pairing a sibling is on (the tool or the
 * consumable), which is why the tag itself needs no direction.
 */
export const productTagSiblingsOut = z.array(
  z.object({
    id: productShortcode,
    name: z.string(),
    manufacturer: z.string(),
    category: productCategory.nullable(),
    tags: z.array(z.string()),
  }),
);
export type ProductTagSiblingsOut = z.infer<typeof productTagSiblingsOut>;

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
  ingredientId: ingredientShortcode
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
      "price per each ($), source of truth. 0 is meaningful and distinct from null: it asserts the item is genuinely free (bundled accessories, freebies), whereas null means nobody has priced it yet — the same convention expense.cost uses.",
    ),
  unitMappings: z
    .array(mcpUnitMappingInput)
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
  // Same reason as aliases — hand-written shape, so this has to be listed.
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Compatibility/grouping tags, e.g. "grinder-4.5in" or "M18" (replaces the existing list). Tag a tool and the consumables that fit it with the same value; `category` distinguishes which is which.',
    ),
  // Same reason as aliases — hand-written shape, so this has to be listed to be
  // writable. Omitting it leaves existing rows untouched (see productUpdateData).
  externalIds: z
    .array(
      z.object({
        source: z.string().min(1),
        externalId: z.string().min(1),
        url: z.string().url().nullish(),
      }),
    )
    .optional()
    .describe(
      'Retailer/vendor identifiers, e.g. an Amazon ASIN → [{ source: "amazon", externalId: "B0..." }]. Pass the COMPLETE desired set: it replaces the existing list. One id per (product, source).',
    ),
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
  ingredientId: ingredientShortcode.nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  usdaUnavailable: z.boolean().nullable().optional(),
});

/** Slim MCP projection of a product list/detail row. */
export const productMcpOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  upc: upc.nullable(),
  category: productCategory.nullable(),
  tags: z.array(z.string()),
  price: z.number().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  // USDA FoodData Central id — declared exception, not a cubby shortcode.
  fdc_id: fdcId.nullable(),
  usdaUnavailable: z.boolean().nullable(),
  externalIds: z.array(
    z.object({
      source: z.string().min(1),
      externalId: z.string().min(1),
      url: z.string().url().nullish(),
      createdAt: z.date(),
      updatedAt: z.date(),
    }),
  ),
  // USDA FoodData Central id — declared exception, not a cubby shortcode.
  usdaFdcId: z.number().nullable(),
  ingredientId: ingredientShortcode.nullable(),
  unitMappings: z.array(mcpUnitMappingOut),
  dataQuality,
});
export type ProductMcpOut = z.infer<typeof productMcpOut>;

export const productMcpListOut = createPaginatedResponseSchema(productMcpOut);

export const productExternalIdCollisionsOut = z.object({
  items: z.array(
    z.object({
      source: z.string(),
      externalId: z.string(),
      products: z.array(z.object({ id: productShortcode, name: z.string() })),
    }),
  ),
});
