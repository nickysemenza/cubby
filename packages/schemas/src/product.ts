import {
  inventoryPlacementValues,
  productCategoryValues,
  UNSPECIFIED_MANUFACTURER,
} from "@cubby/shared";
import { fdcId, foodSummary, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { productRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import {
  dataQuality,
  dataQualityStatus,
  productDataCheck,
} from "./data-quality";
import { amount } from "./codec";
import { requiredName } from "./common";
import {
  externalIdInputs,
  externalIdKind,
  externalIdOut,
  externalIdSource,
  externalIdValues,
} from "./external-id";
import {
  expenseShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  imageOut,
  ImageRenderStatus,
  ImageStatus,
  ImageStorageStatus,
} from "./image";
import {
  locationAncestorOut,
  locationListRefOut,
  locationOutFields,
  locationPathRefOut,
} from "./location";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { baseKind } from "./problems";
import { plainDate, taskStatusSchema } from "./project";
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
  // This presence-only predicate is shared by the public shortcode form and
  // the private UUID repo boundary, so it deliberately accepts either shape.
  ingredientId?: string | null;
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
      "Current chosen per-each costing/replacement price ($), not historical spend. 0 means genuinely free; null means no current price is recorded.",
    ),
  unitMappings: z
    .array(unitMappingInput)
    .default([])
    .describe(
      'Conversion/price edges, e.g. 8 oz = $10 → [{ a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }]. For a weight-measured ingredient an oz/g → dollar edge is the cost basis.',
    ),
  externalIds: externalIdInputs.default([]),
  usdaUnavailable: z
    .boolean()
    .nullable()
    .optional()
    .describe("no USDA food exists — expect manual weight/volume/calories"),
  stockTracked: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "whether shelf records are kept for this kind of thing: null = undecided, false = reviewed/no shelf claim, true = tracked",
    ),
  pendingImageIds: z.array(z.uuid()).optional(),
};

export const productCreateInput = z.object(productCreateShape);

// A partial update makes every create field optional and — critically — strips
// the create-time `.default([])` off `unitMappings`/`externalIds` so omitting
// them leaves the existing rows UNCHANGED (see deriveUpdateData). `removeImageIds`
// is update-only.
export const productUpdateData = deriveUpdateData(productCreateShape, {
  extend: {
    removeImageIds: z
      .array(z.uuid())
      .optional()
      .describe(
        "Image ids to detach. Detaching DELETES the stored file when nothing else references it — there is no restore, and the id will not resolve again.",
      ),
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

// Keep ancillary product hydration batches stricter than the general 1000-row
// backend ceiling so each summary query has bounded database and serialization
// work and retains useful cache granularity.
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
  ...auditDateFilterFields,
  ...productRelatedFilterFields,
  nameFilter: z.string().optional().describe("Filter by product name"),
  manufacturerFilter: z.string().optional().describe("Filter by manufacturer"),
  manufacturerExact: oneOrMany(z.string()).optional(),
  upcFilter: z.string().optional().describe("Filter by UPC code"),
  upcPresenceFilter: presenceFilter,
  modelFilter: z
    .string()
    .optional()
    .describe(
      "Filter by model number — a tool's real identity when the name is generic.",
    ),
  modelPresenceFilter: presenceFilter,
  notesFilter: z.string().optional(),
  notesPresenceFilter: presenceFilter,
  externalIdSource: oneOrMany(externalIdSource).optional(),
  externalIdPresenceFilter: presenceFilter,
  dataStatus: dataQualityStatus.optional(),
  dataGap: oneOrMany(productDataCheck).optional(),
  categoryFilter: oneOrMany(productCategory)
    .optional()
    .describe("Filter by category"),
  inventoryPresenceFilter: presenceFilter,
  inventoryMultiplicity: z
    .enum(["duplicate_within_placement"])
    .optional()
    .describe(
      "Products expected once but recorded more than once within stock or installed placement.",
    ),
  ownershipReconciliation: z
    .enum(["disposed_still_on_hand"])
    .optional()
    .describe(
      "Products with a recorded disposal, no remaining known quantity, and a positive single-unit on-hand count.",
    ),
  conversionCoverage: z
    .enum(["partial"])
    .optional()
    .describe("Products whose persisted conversion coverage is partial."),
  conversionTopology: z
    .enum(["islanded"])
    .optional()
    .describe(
      "Products whose persisted conversion graph has multiple islands.",
    ),
  /**
   * Whether any Location IS this product — a bin, tote or rack in service,
   * rather than stock held on a shelf.
   *
   * Separate from `inventoryPresenceFilter` on purpose: the two are different
   * kinds of presence, and "Not on a shelf" means neither of them.
   */
  servingAsLocationPresenceFilter: presenceFilter.describe(
    "Filter to products that are / aren't in service as a Location.",
  ),
  locationIdFilter: oneOrMany(locationShortcode).optional(),
  ingredientPresenceFilter: presenceFilter,
  ingredientIdFilter: oneOrMany(ingredientShortcode).optional(),
  taskStatusFilter: oneOrMany(taskStatusSchema).optional(),
  taskOpenOnly: z.boolean().optional(),
  taskDueFrom: plainDate.optional(),
  taskDueTo: plainDate.optional(),
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
  expenseCountMin: z.coerce.number().int().nonnegative().optional(),
  expenseCountMax: z.coerce.number().int().nonnegative().optional(),
  expenseTotalMin: z.coerce.number().optional(),
  expenseTotalMax: z.coerce.number().optional(),
  /**
   * Inclusive, SIGNED bounds on units bought minus units gone.
   * `expectedQuantityMax: -1` is the "sold or returned more than was ever
   * bought" worklist — a real data defect, and the reason this is not clamped
   * at zero.
   */
  expectedQuantityMin: z.coerce.number().int().optional(),
  expectedQuantityMax: z.coerce.number().int().optional(),
  /**
   * Products whose shelf disagrees with the ledger. Restricted to stocked
   * products on purpose: an unstocked product with no expenses has a variance
   * of 0 - 0 and would otherwise flood a worklist meant to surface real
   * disagreements.
   */
  quantityVarianceFilter: z
    .enum(["mismatched", "matched"])
    .optional()
    .describe(
      "mismatched: stocked products whose on-hand units differ from the expected quantity. matched: stocked products where they agree.",
    ),
  /**
   * Products carrying at least one product-linked Expense with no recorded
   * quantity — the data-entry-debt worklist behind the `+N?` cue on the
   * Expected column.
   */
  unknownQuantityLinesFilter: presenceFilter,
  purchaseDatePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have a dated live Purchase linked through an Expense.",
  ),
  purchaseDateFrom: plainDate
    .optional()
    .describe("Match a product with any linked Purchase on or after this date"),
  purchaseDateTo: plainDate
    .optional()
    .describe(
      "Match a product with any linked Purchase on or before this date",
    ),
  /**
   * `product.price` is a nullable column on the root table (not a
   * cross-entity id-set subquery like `expensePresenceFilter`/
   * `inventoryPresenceFilter`) — combine with `inventoryPresenceFilter: "has"`
   * for the valuation-gap worklist: products physically in inventory that
   * nobody has priced yet.
   */
  /**
   * A `misc:` bucket — a heterogeneous pile captured in one row, with no
   * meaningful unit price. `"has"` selects them, `"none"` excludes them.
   *
   * Mirrors `isMiscProduct` (@cubby/shared), a case-insensitive prefix test on
   * the name, as `lower(name) LIKE 'misc:%'`. It exists because buckets are
   * *expected* to be unpriced and unmapped: folding them into those worklists
   * leaves both permanently red, and the per-location valuation summary
   * already counts them separately as `miscNoPrice` rather than missing
   * pricing.
   */
  miscBucketFilter: presenceFilter.describe(
    "Filter to `misc:` bucket products (has) or exclude them (none).",
  ),
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
  /**
   * Products that CONTAIN components — kits and multi-packs. Named for what it
   * tests rather than for "kit", because `kitMembership` already names the
   * transpose (the kits a product is *inside*), and a `kitPresenceFilter` would
   * read as either one.
   */
  componentPresenceFilter: presenceFilter.describe(
    "Filter to products that are / aren't kits — i.e. that do or don't contain at least one component product.",
  ),
  /**
   * `product.stockTracked` is a nullable column on the root table (like
   * `pricePresenceFilter`): `null` = undecided (the review worklist),
   * `false`/`true` = reviewed either way. `"none"` is the undecided worklist;
   * `"has"` means reviewed, regardless of which way it was decided.
   */
  stockTrackedPresenceFilter: presenceFilter.describe(
    "Filter to products whose stockTracked decision is undecided (none) or has been made either way (has).",
  ),
};

export const productFiltersSchema = z.object(productFilterFields);
export type ProductFilters = z.infer<typeof productFiltersSchema>;

export const productMovementKind = z.enum([
  "acquired",
  "exited",
  "discarded",
  // Money came back and no unit moved: a price concession with the item kept.
  // Distinct from "exited" because the timeline draws ownership from these —
  // reading a concession as an exit would end an ownership span the household
  // never ended.
  "adjusted",
  "unknown",
]);
export type ProductMovementKind = z.infer<typeof productMovementKind>;

export const productMovementTimelineInput = z
  .object({
    filters: productFiltersSchema,
    movementFrom: plainDate.optional(),
    movementTo: plainDate.optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine(
    ({ movementFrom, movementTo }) =>
      !movementFrom || !movementTo || movementFrom <= movementTo,
    { message: "Movement start must not be after movement end" },
  );
export type ProductMovementTimelineInput = z.infer<
  typeof productMovementTimelineInput
>;

const productMovementProjectOut = z.object({
  id: projectShortcode,
  name: z.string(),
});

const productMovementLineOut = z.object({
  expenseId: expenseShortcode.nullable(),
  productId: productShortcode,
  name: z.string(),
  kind: productMovementKind,
  cost: z.number().nullable(),
  quantity: z.number().int().nullable(),
  signedQuantity: z.number().int().nullable(),
  expenseDate: plainDate,
  chargedTo: productMovementProjectOut.nullable(),
  provenanceOnly: z.boolean(),
});
export type ProductMovementLineOut = z.infer<typeof productMovementLineOut>;

const productMovementPurchaseOut = z.object({
  id: purchaseShortcode,
  displayLabel: z.string().nullable(),
  orderId: z.string().nullable(),
  date: plainDate.nullable(),
  vendor: z.object({ id: vendorShortcode, name: z.string() }).nullable(),
});

const productMovementGroupOut = z.object({
  key: z.string(),
  date: plainDate,
  purchase: productMovementPurchaseOut.nullable(),
  movements: z.array(productMovementLineOut),
});
export type ProductMovementGroupOut = z.infer<typeof productMovementGroupOut>;

const productMovementProductOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  category: productCategory.nullable(),
  coverImageUrl: z.string().nullable(),
  usedOnProjects: z.array(productMovementProjectOut),
  ownershipIntervals: z.array(z.object({ start: plainDate, end: plainDate })),
  confidenceLostAt: plainDate.nullable(),
});
export type ProductMovementProductOut = z.infer<
  typeof productMovementProductOut
>;

export const productMovementTimelineOut = z.object({
  products: z.array(productMovementProductOut),
  groups: z.array(productMovementGroupOut),
  summary: z.object({
    matchingProducts: z.number().int().nonnegative(),
    productsWithMovements: z.number().int().nonnegative(),
    movementCount: z.number().int().nonnegative(),
    spent: z.number(),
    recovered: z.number().nonnegative(),
    netCost: z.number(),
    unknownAmountCount: z.number().int().nonnegative(),
  }),
  extent: z.object({ from: plainDate, to: plainDate }).nullable(),
  omitted: z.object({
    productsWithoutMovements: z.number().int().nonnegative(),
    plannedMovements: z.number().int().nonnegative(),
  }),
});
export type ProductMovementTimelineOut = z.infer<
  typeof productMovementTimelineOut
>;

export const productSortableFields = [
  "createdAt",
  "updatedAt",
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
  "expenses",
  // Units bought minus units gone, and shelf minus that. Both correlated
  // subqueries in repo/product/quantity-ledger.ts. These strings must stay
  // identical to the column ids in productlist.tsx, or `buildOrderBy` drops
  // the sort while the header still renders a sort affordance.
  "expectedQuantity",
  "quantityVariance",
  // Latest linked Purchase date — resolved by a correlated subquery in
  // repo/product/crud.ts.
  "purchaseDate",
  // Alphabetically first linked Project name — same resolver file.
  "related:product.projects",
  "related:product.vendors",
  "related:product.purchases",
  "identity_strength",
] as const;

export type ProductSortField = (typeof productSortableFields)[number];

/**
 * Units bought minus units gone, derived from the Expense ledger. See
 * repo/product/quantity-ledger.ts for the rule and why every negative line
 * counts as an exit here (unlike `findSoldButStillStocked`'s stricter
 * disposal-Purchase predicate).
 */
export const productQuantityLedgerOut = z.object({
  /** Units acquired: positive-cost lines, plus $0 lines with a positive quantity. */
  acquiredUnits: z.number().int().nonnegative(),
  /** Units gone: negative-cost lines (returns, refunds, sales), plus $0 discards. */
  exitedUnits: z.number().int().nonnegative(),
  /**
   * `acquiredUnits - exitedUnits`. **May be negative** — more units left than
   * the ledger can account for buying, which is a real data defect worth
   * surfacing rather than a number to clamp at zero.
   */
  expectedQuantity: z.number().int(),
  /**
   * Lines that carry no quantity, so they contribute nothing to the totals
   * above. Reported rather than guessed at: a receipt that proves the cost but
   * not the count must not silently read as one unit.
   */
  unknownAcquisitionLines: z.number().int().nonnegative(),
  unknownExitLines: z.number().int().nonnegative(),
  /**
   * Locations that ARE an instance of this product — a bin, tote or rack in
   * service rather than stock on a shelf.
   *
   * Units in use as locations are still units you own, so on-hand counts add
   * this to the inventory sum. Without it every container promoted to a
   * Location would read as missing and light "Shelf disagrees" forever — the
   * same false-variance trap `includes-installed` documents for fixtures.
   */
  locationCount: z.number().int().nonnegative(),
});
export type ProductQuantityLedgerOut = z.infer<typeof productQuantityLedgerOut>;

/**
 * Record that units of a Product were thrown away, given away, or written off.
 *
 * Mints a $0 Expense carrying a NEGATIVE `productQuantity` — the signal that
 * distinguishes a discard from a free acquisition — and, when asked, takes the
 * same units off the shelf in the same transaction.
 */
export const productDiscardInput = z.object({
  productId: productShortcode,
  quantity: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe(
      "Units leaving the household, as a positive count. Stored on the Expense as a NEGATIVE productQuantity.",
    ),
  date: plainDate,
  reason: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .describe(
      "Free text stored as the Expense notes — broken, thrown away, given away.",
    ),
  /**
   * Inventory never auto-decrements (a binding tenet). Clearing the shelf here
   * is not an auto-decrement: it is an explicit instruction on a dialog that
   * names the entry and the count. Opt-OUT rather than implicit, and no other
   * write path may take units off a shelf as a side effect of money.
   */
  adjustInventory: z.boolean().default(true),
  /**
   * Which shelf to take the units from. Required whenever `adjustInventory` is
   * set and the product sits in more than one location — never guessed, since
   * guessing would silently empty the wrong shelf.
   */
  inventoryEntryId: inventoryShortcode.nullable().default(null),
});
export type ProductDiscardInput = z.infer<typeof productDiscardInput>;

export const productDiscardOut = z.object({
  expenseId: expenseShortcode,
  /** Negative, as stored on the row. */
  storedQuantity: z.number().int().negative(),
  inventory: z
    .object({
      entryId: inventoryShortcode,
      /** True when the discard emptied the entry and it was soft-deleted. */
      removed: z.boolean(),
      remainingValue: z.number().nullable(),
    })
    .nullable(),
  sideEffects: mutationSideEffectsSchema,
});
export type ProductDiscardOut = z.infer<typeof productDiscardOut>;

export const productPricingOut = z.object({
  derivedPrice: z.number().nullable(),
  effectivePrice: z.number().nullable(),
  source: z.enum(["explicit", "derived", "none"]),
  knownExpenseCount: z.number().int().nonnegative(),
  unknownExpenseCount: z.number().int().nonnegative(),
  knownUnitCount: z.number().int().nonnegative(),
  partial: z.boolean(),
});
export type ProductPricingOut = z.infer<typeof productPricingOut>;

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
  price: z
    .number()
    .nullable()
    .describe(
      "Manual per-item valuation/replacement-price override; null resumes the Expense-derived fallback.",
    ),
  pricing: productPricingOut,
  usdaUnavailable: z.boolean().nullable(),
  stockTracked: z.boolean().nullable(),
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

// What a barcode resolves to, from every source at once and WITHOUT creating
// anything. The identity fields mirror exactly what findOrCreateByUPC would
// have written, so "what would this create?" and "what is this?" cannot give
// different answers.
export const productLookupUpcOut = z.object({
  upc: z.string(),
  localProduct: productTopLevelOut
    .nullable()
    .describe("The Product already claiming this barcode, if any"),
  usdaFood: z
    .object({
      fdc_id: z.number().int(),
      name: z.string(),
      manufacturer: z.string(),
    })
    .nullable()
    .describe("USDA branded-food match"),
  externalLookup: z
    .object({
      name: z.string(),
      manufacturer: z.string(),
      price: z.number().nullable(),
      source: z.string(),
      category: z.string().nullable(),
      description: z.string().nullable(),
      imageUrl: z.url().nullable(),
    })
    .nullable()
    .describe("UPC lookup service match"),
});

export type ProductLookupUpcOut = z.infer<typeof productLookupUpcOut>;

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
  // Included on purpose: "where does this product live" is an ownership
  // question, so the dimmer wired into the kitchen wall belongs in this list.
  // Carrying placement is what lets the row say "installed" instead of
  // reporting a verification age a fixture can never have.
  placement: z.enum(inventoryPlacementValues),
  ...timestampedFields,
};

const productInventoryWithLocationOut = z.object({
  ...productInventoryFields,
  location: z.object({
    ...locationOutFields,
    /** Root → immediate parent, hydrated once for the whole detail read. */
    ancestors: z.array(locationAncestorOut),
  }),
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
  category: productCategory.nullable(),
  price: z.number().nonnegative().nullable(),
  coverImageUrl: z.string().nullable(),
  quantityLedger: productQuantityLedgerOut,
  onHand: z.discriminatedUnion("state", [
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("counted"), units: z.number() }),
    z.object({ state: z.literal("mixed") }),
  ]),
});
export type ProductPickerItemOut = z.infer<typeof productPickerItemOut>;
export type ProductPickerOnHandOut = ProductPickerItemOut["onHand"];

/**
 * Units expected on hand, what is actually on the shelf, and the gap between
 * them. One definition shared by the list row and every detail shape, so the
 * two surfaces cannot describe the same numbers differently — the drift that
 * produced two bugs when the list owned its own copy.
 */
export const productQuantityFields = {
  quantityLedger: productQuantityLedgerOut,
  /**
   * Live units across every shelf this product sits on. Null when it is not
   * stocked at all, and null when its entries carry MORE THAN ONE unit — a
   * count of `each` plus a volume of `can` has no meaningful sum, so callers
   * render `—` rather than adding apples to oranges.
   */
  onHandUnits: z.number().nullable(),
  /**
   * `onHandUnits - quantityLedger.expectedQuantity`. Null exactly when
   * `onHandUnits` is. Zero means the shelf and the ledger agree.
   */
  quantityVariance: z.number().nullable(),
};

export const productWithIngredientAndInventoryAndMappingsOut = z.object({
  ...productTopLevelFields,
  ingredient: productIngredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(productInventoryWithLocationOut),
  /**
   * Locations that ARE this product — a bin, tote or rack in service, as
   * opposed to `inventoryEntry`, which is stock held somewhere.
   *
   * Embedded on the detail read rather than fetched beside it, so the hero's
   * count and the rows in the table cannot disagree while one of two queries is
   * still in flight.
   */
  servingAsLocations: z.array(locationPathRefOut),
  ...productQuantityFields,
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
  // Live `ProductComponent` edges where this product is the parent — non-zero
  // means it's a kit or multi-pack. Counts distinct components, not units: a
  // 4-pack stored as one edge with `quantity: 4` reads as 1.
  componentCount: z.number().int().nonnegative(),
  // Net basis: SUM(expense.cost) over this product's live expenses. Plain sum
  // IS the net basis here — negative rows (refunds, disposals) are real in
  // this ledger, so they telescope correctly. 0 for a product with no
  // expenses, never null.
  expenseTotal: z.number(),
  // A product can appear on several Expense lines/Purchases. The table shows
  // the latest live Purchase date as the compact scalar provenance cue.
  purchaseDate: plainDate.nullable(),
  ...productQuantityFields,
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
  servingAsLocations: z.array(locationPathRefOut),
  food: foodSummary.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  ...productQuantityFields,
});
export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

export const productWithFoodAndSideEffectsOut = z.object({
  ...productTopLevelFields,
  ingredient: productIngredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(productInventoryWithLocationOut),
  servingAsLocations: z.array(locationPathRefOut),
  food: foodSummary.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  sideEffects: mutationSideEffectsSchema,
  ...productQuantityFields,
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
 * The external-ID source slugs actually stored, with the number of live
 * products carrying each. A static list would rot: sources are minted by
 * whichever importer wrote the row, so the roster comes from the data.
 */
export const productExternalIdSourceOptionsOut = z.array(
  z.object({
    source: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type ProductExternalIdSourceOptionsOut = z.infer<
  typeof productExternalIdSourceOptionsOut
>;

export const productManufacturerOptionsOut = z.array(
  z.object({
    manufacturer: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type ProductManufacturerOptionsOut = z.infer<
  typeof productManufacturerOptionsOut
>;

/**
 * "Fits With" — the products sharing a tag with the one being viewed, plus
 * where each tag's family is stored.
 *
 * Each sibling carries its own full `tags` so the client can group by the
 * shared tag — `category` is what tells you which side of the pairing a
 * sibling is on (the tool or the consumable), which is why the tag itself
 * needs no direction.
 *
 * `tagStorage` is keyed by the same tags, so the two halves render as one
 * grouped list from a single round trip.
 */
export const productTagSiblingsOut = z.object({
  siblings: z.array(
    z.object({
      id: productShortcode,
      name: z.string(),
      manufacturer: z.string(),
      category: productCategory.nullable(),
      tags: z.array(z.string()),
    }),
  ),
  tagStorage: z.array(
    z.object({
      tag: z.string(),
      locations: z.array(
        z.object({
          id: locationShortcode,
          name: z.string(),
          /** Root → immediate parent. Empty for a top-level location. */
          ancestors: z.array(locationAncestorOut),
          /** Distinct sibling products stocked here, never the viewed one. */
          productCount: z.number().int().positive(),
          /** The viewed product is stocked here too. */
          holdsSource: z.boolean(),
        }),
      ),
      /** Locations the server truncated away, for visible disclosure. */
      omittedLocationCount: z.number().int().nonnegative(),
    }),
  ),
});
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
  aliases: z
    .array(z.string())
    .default([])
    .describe("Alternate names (replaces the complete alias set)"),
  tags: z
    .array(z.string())
    .default([])
    .describe("Compatibility/grouping tags (replaces the complete tag set)"),
  fdc_id: fdcId
    .nullable()
    .optional()
    .describe("USDA FoodData Central id; null means no explicit USDA link"),
  model: z
    .string()
    .nullish()
    .describe("Maker-issued model or MPN, not a retailer SKU"),
  notes: z.string().nullish().describe("Product notes, URLs, or other details"),
  expectedQuantity: z.number().int().positive().nullable().optional(),
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
      "Current chosen per-each costing/replacement price ($), not historical spend. 0 means genuinely free; null means no current price is recorded.",
    ),
  unitMappings: z
    .array(mcpUnitMappingInput)
    .default([])
    .describe(
      'Conversion/price edges, e.g. 8 oz = $10 → [{ a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }]. For a weight-measured ingredient an oz/g → dollar edge is the cost basis.',
    ),
  externalIds: externalIdValues
    .default([])
    .describe("Typed manufacturer, marketplace, or retailer identifiers"),
  usdaUnavailable: z
    .boolean()
    .nullable()
    .optional()
    .describe("no USDA food exists — expect manual weight/volume/calories"),
  stockTracked: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "whether shelf records are kept for this kind of thing: null = undecided, false = reviewed/no shelf claim, true = tracked",
    ),
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
  externalIds: externalIdValues
    .optional()
    .describe(
      "Retailer/vendor identifiers. Pass the COMPLETE desired set: it replaces the existing list. One id per (product, source, kind).",
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
  unitMappings: z
    .array(mcpUnitMappingInput)
    .optional()
    .describe(
      "Complete replacement set of conversion/price mappings; an empty array clears all mappings.",
    ),
  usdaUnavailable: z.boolean().nullable().optional(),
  stockTracked: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "whether shelf records are kept for this kind of thing: null = undecided, false = reviewed/no shelf claim, true = tracked",
    ),
  removeImageIds: z
    .array(z.uuid())
    .optional()
    .describe(
      "Product image ids to detach; an id not currently attached to this product is silently ignored. Detaching DELETES the stored file when nothing else references it — there is no restore.",
    ),
  imageOrder: z
    .array(z.uuid())
    .optional()
    .describe("Product image ids in display order; first valid image is cover"),
});

/** Slim MCP projection of a product list/detail row. */
const productMcpFields = {
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  upc: upc.nullable(),
  category: productCategory.nullable(),
  tags: z.array(z.string()),
  price: z.number().nullable().describe("Effective valuation/costing price"),
  priceOverride: z.number().nullable(),
  pricing: productPricingOut,
  expectedQuantity: z.number().int().positive().nullable(),
  imageCount: z.number().int().nonnegative(),
  coverImageUrl: z.url().nullable(),
  // USDA FoodData Central id — declared exception, not a cubby shortcode.
  fdc_id: fdcId.nullable(),
  usdaUnavailable: z.boolean().nullable(),
  stockTracked: z.boolean().nullable(),
  externalIds: z.array(
    z.object({
      source: externalIdSource,
      kind: externalIdKind,
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
};
export const productMcpOut = z.object(productMcpFields);
export type ProductMcpOut = z.infer<typeof productMcpOut>;

export const productMcpImageOut = z.object({
  id: z.uuid(),
  url: z.url(),
  key: z.string(),
  filename: z.string(),
  size: z.int().positive(),
  contentType: z.string(),
  status: ImageStatus,
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  detectedContentType: z.string().nullable(),
  sha256: z.string().nullable(),
  renderStatus: ImageRenderStatus.nullable(),
  storageStatus: ImageStorageStatus.nullable(),
  verifiedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  displayPosition: z.number().int().positive().nullable(),
  isCover: z.boolean(),
});

/** Detailed MCP projection used only by get/mutations that need media state. */
export const productMcpDetailOut = z.object({
  ...productMcpFields,
  coverImageId: z.uuid().nullable(),
  images: z.array(productMcpImageOut),
});
export type ProductMcpDetailOut = z.infer<typeof productMcpDetailOut>;

export const productMcpListOut = createPaginatedResponseSchema(productMcpOut);

export const productExternalIdCollisionsOut = z.object({
  items: z.array(
    z.object({
      source: z.string(),
      kind: externalIdKind,
      externalId: z.string(),
      products: z.array(z.object({ id: productShortcode, name: z.string() })),
    }),
  ),
  results: z
    .array(
      z.object({
        source: z.string(),
        kind: externalIdKind,
        externalId: z.string(),
        status: z.enum(["missing", "unique", "collision"]),
        products: z.array(z.object({ id: productShortcode, name: z.string() })),
      }),
    )
    .default([]),
});

export const productExternalIdCollisionInput = z
  .object({
    source: z.union([externalIdSource, z.array(externalIdSource)]).optional(),
    identifiers: z
      .array(
        z.object({
          source: externalIdSource,
          kind: externalIdKind,
          externalId: z.string().min(1),
        }),
      )
      .min(1)
      .max(100)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source !== undefined && value.identifiers !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source and identifiers cannot be used together",
        path: ["identifiers"],
      });
  });

export const patchProductExternalIdsInput = z
  .object({
    id: productShortcode,
    upsert: z
      .array(
        z.object({
          source: externalIdSource,
          kind: externalIdKind,
          externalId: z.string().min(1),
          url: z.string().url().nullish(),
        }),
      )
      .default([]),
    remove: z
      .array(
        z.object({
          source: externalIdSource,
          kind: externalIdKind,
          expectedExternalId: z.string().min(1),
        }),
      )
      .default([]),
  })
  .superRefine((value, ctx) => {
    const slots = new Set<string>();
    for (const entry of [...value.upsert, ...value.remove]) {
      const key = `${entry.source.trim().toLowerCase()}\u0000${entry.kind}`;
      if (slots.has(key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each external-ID slot may be patched only once",
        });
      slots.add(key);
    }
  });

/**
 * Fold duplicate products into one. A user action, never an import guess:
 * `Product_name_manufacturer_key` only stops an *exact* repeat, so the same
 * physical SKU can land twice under two spellings, and nothing on the write
 * path can safely decide two rows are the same thing.
 *
 * See `mergeProducts` (repo/product/merge.ts) for the two structural collisions
 * it resolves — the per-product `(source, kind)` identifier slot and the
 * `(productId, locationId)` stock slot.
 */
export const mergeProductsInput = z.object({
  keepId: productShortcode,
  mergeIds: z.array(productShortcode).min(1),
});
export type MergeProductsInput = z.infer<typeof mergeProductsInput>;

/** What a merge actually moved, folded, or discarded. */
export const productMergeSummaryOut = z.object({
  keepId: productShortcode,
  deletedIds: z.array(productShortcode),
  externalIdsMoved: z.number().int(),
  externalIdsDiscarded: z.number().int(),
  inventoryMoved: z.number().int(),
  inventoryMerged: z.number().int(),
  expensesMoved: z.number().int(),
  imagesMoved: z.number().int(),
  unitMappingsMoved: z.number().int(),
  tasksMoved: z.number().int(),
  projectUsesMoved: z.number().int(),
  purchaseLinksMoved: z.number().int(),
  wishCandidatesMoved: z.number().int(),
  aliasesAdded: z.array(z.string()),
  carriedFields: z.array(z.string()),
});
export type ProductMergeSummaryOut = z.infer<typeof productMergeSummaryOut>;

export const mergeProductsOut = z.object({
  product: productWithFoodOut,
  mergeSummary: productMergeSummaryOut,
});
export type MergeProductsOut = z.infer<typeof mergeProductsOut>;

/** `merge_products`' MCP payload — the slim product, not the USDA-enriched one. */
export const mergeProductsMcpOut = z.object({
  product: productMcpOut,
  mergeSummary: productMergeSummaryOut,
});
