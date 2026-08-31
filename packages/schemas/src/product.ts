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
  dateRangeFields,
  deriveUpdateData,
  numericRangeFields,
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
  money,
  moneyNullable,
  positiveMoney,
  positiveMoneyNullable,
} from "./money";
import {
  externalIdInputs,
  externalIdKind,
  externalIdOut,
  externalIdSource,
  externalIdValues,
  gtin,
} from "./external-id";
import { isbn } from "./isbn";
import {
  cookbookShortcode,
  expenseShortcode,
  imageShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  taskShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  imageOut,
  ImageRenderStatus,
  ImageStatus,
  ImageStorageStatus,
} from "./image";
import { imageUrlSummary } from "./image-summary";
import {
  locationAncestorFields,
  locationAncestorOut,
  locationListRefOut,
  locationOutFields,
  locationPathRefFields,
} from "./location";
import {
  createPaginatedResponseSchema,
  entityFilterList,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { baseKind } from "./problems";
import { plainDate, projectStatusSchema, taskStatusSchema } from "./project";
import { purchaseProductSource } from "./purchase";
import { recipeUsageMcpEntityOut, recipeUsageOut } from "./recipe";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  mcpUnitMappingOut,
  mcpUnitMappingInput,
  unitMappingInput,
  unitMappingOut,
  unitMappingWithMetadata,
} from "./unitmapping";

export const productCategory = z
  .enum(productCategoryValues)
  .describe("Product category");

export type ProductCategory = z.infer<typeof productCategory>;

export { productCategoryValues } from "@cubby/shared";

/**
 * The explicit USDA food link: a positive `fdc_id`. One definition shared by
 * {@link hasFoodIndicators} and the problems repo's food-category detector, so
 * "what counts as an fdc link" can't drift between them.
 */
export const hasFdcLink = (fdc_id: number | null | undefined): boolean =>
  fdc_id != null && fdc_id > 0;

export const hasFoodIndicators = (product: {
  fdc_id?: number | null;
  // This presence-only predicate is shared by the public shortcode form and
  // the private UUID repo boundary, so it deliberately accepts either shape.
  ingredientId?: string | null;
}): boolean =>
  hasFdcLink(product.fdc_id) ||
  (product.ingredientId != null && product.ingredientId.length > 0);

const productCreateFields = {
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
  upc: gtin.nullable(),
  isbn: isbn
    .nullable()
    .optional()
    .describe(
      "Physical-book ISBN-10 or ISBN-13; stored as the equivalent canonical GTIN-14 and categorizes the Product as books",
    ),
  fdc_id: fdcId
    .nullable()
    .optional()
    .describe(
      "USDA FoodData Central id — links the product to any USDA food (takes precedence over the product's barcode). null to unlink.",
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
  price: positiveMoneyNullable
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
  // Public `IMG-` shortcode — `Image` mints one at insert time, so the repo
  // layer resolves this to a uuid before the join-table write.
  pendingImageIds: z.array(imageShortcode).optional(),
};

export const productCreateInput = z.object(productCreateFields);

// A partial update makes every create field optional and — critically — strips
// the create-time `.default([])` off `unitMappings`/`externalIds` so omitting
// them leaves the existing rows UNCHANGED (see deriveUpdateData). `removeImageIds`
// is update-only.
export const productUpdateData = deriveUpdateData(productCreateFields, {
  extend: {
    // Public `IMG-` codes, as returned by the web `ProductOut.images[].id` —
    // resolved to uuids in the repo before they reach the `ProductImage` join
    // table. The MCP surface is a separate schema (`mcpProductUpdateInput`
    // below) that still speaks raw uuids, matching `productMcpImageOut`.
    removeImageIds: z
      .array(imageShortcode)
      .optional()
      .describe(
        "Image ids to detach. Detaching DELETES the stored file when nothing else references it — there is no restore, and the id will not resolve again.",
      ),
    imageOrder: z
      .array(imageShortcode)
      .optional()
      .describe("existing image ids in display order; first = cover"),
  },
});

export const productUpdateInput = z.object({
  id: productShortcode,
  data: productUpdateData,
});

export const productBulkStockTrackedInput = z.object({
  ids: z.array(productShortcode).min(1),
  stockTracked: z.boolean().nullable(),
});
export type ProductBulkStockTrackedInput = z.infer<
  typeof productBulkStockTrackedInput
>;

export const PRODUCT_SUMMARY_BATCH_MAX = 50;

export const productSummaryBatchInput = z.object({
  ids: z.array(productShortcode).max(PRODUCT_SUMMARY_BATCH_MAX),
});

export const PRODUCT_QUANTITY_SUMMARY_BATCH_MAX = 5_000;

export const productQuantitySummaryBatchInput = z.object({
  ids: z.array(productShortcode).max(PRODUCT_QUANTITY_SUMMARY_BATCH_MAX),
});

/**
 * "Where does each of these products live" for a bounded set of ids — the
 * batch companion to `productQuantitySummaryBatchInput`.
 *
 * Shortcode-keyed rather than a field on the rows that need it: the callers are
 * tables whose row entity ISN'T a product (a task's subject product, say), and
 * threading stock onto those row shapes would make every other producer of them
 * emit an empty array it never loaded.
 */
export const productInventoryEntriesBatchInput = z.object({
  ids: z.array(productShortcode).max(PRODUCT_QUANTITY_SUMMARY_BATCH_MAX),
});

export const productApplyUpcInput = z.object({
  id: productShortcode,
  upc,
});

export const productFindOrCreateByUPCInput = z.object({
  upc,
  defaultName: z.string().optional(),
});

export const productFindOrCreateByCodeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("barcode"), value: upc }),
  z.object({ kind: z.literal("isbn"), value: isbn }),
]);

export type ProductFindOrCreateByCodeInput = z.infer<
  typeof productFindOrCreateByCodeInput
>;

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

export const productFilterFields = {
  ...auditDateFilterFields,
  ...productRelatedFilterFields,
  nameFilter: z.string().optional().describe("Filter by product name"),
  manufacturerFilter: z.string().optional().describe("Filter by manufacturer"),
  manufacturerExact: oneOrMany(z.string()).optional(),
  upcFilter: z
    .string()
    .optional()
    .describe("Filter by UPC/barcode — matches ANY of the product's barcodes"),
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
  /**
   * Kits accounted for twice: stocked under their own name AND by their parts,
   * together exceeding what the ledger says was acquired.
   *
   * Deliberately NOT "the parent is stocked XOR its parts are". A partially
   * opened multi-pack is legitimately both — two AirTag 4-packs, one opened
   * into four singles and one still sealed, is `1 parent + 4 components` and
   * values correctly. Only accounting for more units than were bought is
   * always wrong.
   */
  kitAccounting: z
    .enum(["double_counted"])
    .optional()
    .describe(
      "Kits stocked as themselves AND as their components, together accounting for more units than the ledger says were acquired.",
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
  locationIdFilter: entityFilterList(locationShortcode).optional(),
  ingredientPresenceFilter: presenceFilter,
  ingredientIdFilter: entityFilterList(ingredientShortcode).optional(),
  taskStatusFilter: oneOrMany(taskStatusSchema).optional(),
  taskOpenOnly: z.boolean().optional(),
  ...dateRangeFields("taskDue"),
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
  categoryPresenceFilter: presenceFilter,
  expensePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have at least one expense in the ledger. Both acquisitions and exits (negative rows) count.",
  ),
  ...numericRangeFields("expenseCount", { int: true, nonnegative: true }),
  ...numericRangeFields("expenseTotal"),
  ...numericRangeFields("expectedQuantity"),
  quantityVarianceFilter: z
    .enum(["mismatched", "matched"])
    .optional()
    .describe(
      "mismatched: stocked products whose on-hand units differ from the expected quantity. matched: stocked products where they agree.",
    ),
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
   * primary barcode is auto-matched against USDA branded foods, which may find
   * nothing. SQL can only see whether a key exists. `usdaUnavailable` is
   * deliberately NOT folded in: setting it doesn't clear the `fdc_id` or the
   * barcode, so a product can be
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
    ...dateRangeFields("movement"),
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
  cost: moneyNullable,
  quantity: z.number().nullable(),
  signedQuantity: z.number().nullable(),
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
    spent: money,
    // Read shape but constrained nonnegative like a write boundary — a
    // refunded/recovered amount can't be negative by construction, so this is
    // an intentional invariant rather than a convention drift. See money.ts.
    recovered: positiveMoney,
    netCost: money,
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
  "primaryGtin",
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
  "purchaseDate",
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
  acquiredUnits: z.number().nonnegative(),
  exitedUnits: z.number().nonnegative(),
  expectedQuantity: z.number(),
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
    .positive()
    .default(1)
    .describe(
      "Units leaving the household, as a positive count. May be fractional — half a coil is 0.5. Stored on the Expense as a NEGATIVE productQuantity.",
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
  storedQuantity: z.number().negative(),
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
  derivedPrice: moneyNullable,
  effectivePrice: moneyNullable,
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
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId
    .nullable()
    .describe(
      "USDA FoodData Central id — links the product to any USDA food (takes precedence over the product's barcode). null to unlink.",
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
  price: moneyNullable.describe(
    "Manual per-item valuation/replacement-price override; null resumes the Expense-derived fallback.",
  ),
  pricing: productPricingOut,
  usdaUnavailable: z.boolean().nullable(),
  stockTracked: z.boolean().nullable(),
  dataQuality,
  ...timestampedFields,
};

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
      price: moneyNullable,
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
  valuation: moneyNullable,
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

const productLocationAncestorOut = z.object({
  ...locationAncestorFields,
  displayImage: imageUrlSummary.nullable(),
});

export const productCookbookRefOut = z.object({
  id: cookbookShortcode,
  name: z.string(),
  recipeCount: z.number().int().nonnegative(),
});
export type ProductCookbookRefOut = z.infer<typeof productCookbookRefOut>;

const productLocationRefOut = z.object({
  ...locationPathRefFields,
  displayImage: imageUrlSummary.nullable(),
  ancestors: z.array(productLocationAncestorOut),
});

const productInventoryWithLocationOut = z.object({
  ...productInventoryFields,
  location: z.object({
    ...locationOutFields,
    displayImage: imageUrlSummary.nullable(),
    ancestors: z.array(productLocationAncestorOut),
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

const productExternalIdMcpEntityOut = externalIdOut.omit({ id: true });
const productUnitMappingMcpEntityOut = unitMappingOut.omit({ id: true });

/** Product references embedded in MCP entity results never expose child-row ids. */
export const productWithMappingsMcpEntityOut = productWithMappingsOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
  unitMappings: z.array(productUnitMappingMcpEntityOut),
});

export const productWithMappingsAndFoodMcpEntityOut =
  productWithMappingsAndFoodOut.extend({
    externalIds: z.array(productExternalIdMcpEntityOut),
    unitMappings: z.array(productUnitMappingMcpEntityOut),
  });

export const productPickerItemOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  category: productCategory.nullable(),
  // Read shape but constrained nonnegative like a write boundary; kept as-is
  // (see money.ts convention note) rather than silently loosened here.
  price: positiveMoneyNullable,
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
  onHandUnits: z.number().nullable(),
  quantityVariance: z.number().nullable(),
};

export const productQuantitySummaryOut = z.object(productQuantityFields);
export type ProductQuantitySummaryOut = z.infer<
  typeof productQuantitySummaryOut
>;

/** Public product shortcode → canonical shelf-versus-ledger quantity shape. */
export const productQuantitySummariesOut = z.record(
  z.string(),
  productQuantitySummaryOut,
);
export type ProductQuantitySummariesOut = z.infer<
  typeof productQuantitySummariesOut
>;

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
  servingAsLocations: z.array(productLocationRefOut),
  /**
   * Live `ProductComponent` edges where this product is the parent — non-zero
   * means it is a kit or multi-pack. Counts distinct components, not units.
   *
   * Embedded here rather than read from `product.components` beside it, for the
   * reason `servingAsLocations` gives above: the hero decides its presence
   * stamp from this, and a stamp that flipped when a second query resolved
   * would contradict the Kit Components table while it loaded.
   */
  componentCount: z.number().int().nonnegative(),
  /** Live cookbooks whose physical copies are this product. */
  cookbooks: z.array(productCookbookRefOut),
  ...productQuantityFields,
});

export const productListInventoryEntryOut = z.object({
  ...productInventoryFields,
  location: locationListRefOut,
});
export type ProductListInventoryEntryOut = z.infer<
  typeof productListInventoryEntryOut
>;

/** Public product shortcode → its live stock entries and their locations. */
export const productInventoryEntriesByIdOut = z.record(
  z.string(),
  z.array(productListInventoryEntryOut),
);
export type ProductInventoryEntriesByIdOut = z.infer<
  typeof productInventoryEntriesByIdOut
>;

/**
 * Compact, Product-owned route data for the inspector and canonical detail
 * page. This is intentionally not the generic related-view transport: a
 * Product needs to distinguish stock from a Location whose identity it is,
 * purchase provenance from ordinary spend, and a Product used on a project
 * from a Product merely purchased for one.
 *
 * Every preview is bounded at the repository seam; `count` is always the
 * complete live cardinality, before that cap. All ids are canonical public
 * shortcodes so the caller can navigate without learning database ids.
 */
export const productRelationshipRouteInput = z.object({
  productId: productShortcode,
});

const productRelationshipPreview = <T extends z.ZodType>(item: T) =>
  z.object({
    count: z.number().int().nonnegative(),
    preview: z.array(item).max(3),
  });

const productRelationshipEntityRef = <T extends z.ZodType>(id: T) =>
  z.object({ id, name: z.string() });

const productRelationshipProjectRef = productRelationshipEntityRef(
  projectShortcode,
).extend({ status: projectStatusSchema });

const productRelationshipExpenseOut = z.object({
  id: expenseShortcode,
  name: z.string(),
  cost: moneyNullable,
  date: plainDate,
  project: productRelationshipProjectRef.nullable(),
});

const productRelationshipPurchaseOut = z.object({
  id: purchaseShortcode,
  displayLabel: z.string().nullable(),
  orderId: z.string().nullable(),
  date: plainDate,
  vendor: productRelationshipEntityRef(vendorShortcode).nullable(),
  source: purchaseProductSource,
  linkAttachedAt: z.date().nullable(),
});

const productRelationshipTaskOut = z.object({
  id: taskShortcode,
  name: z.string(),
  status: taskStatusSchema,
  dueDate: plainDate.nullable(),
  project: productRelationshipProjectRef.nullable(),
});

const productRelationshipInventoryOut = z.object({
  id: inventoryShortcode,
  amount,
  placement: z.enum(inventoryPlacementValues),
  location: productRelationshipEntityRef(locationShortcode),
});

export const productRelationshipRouteOut = z.object({
  productId: productShortcode,
  direct: z.object({
    inventory: productRelationshipPreview(
      productRelationshipInventoryOut,
    ).extend({
      stockCount: z.number().int().nonnegative(),
      installedCount: z.number().int().nonnegative(),
    }),
    identityLocations: productRelationshipPreview(
      productRelationshipEntityRef(locationShortcode),
    ),
    expenses: productRelationshipPreview(productRelationshipExpenseOut).extend({
      netCost: money,
    }),
    purchases: productRelationshipPreview(productRelationshipPurchaseOut),
    usedOnProjects: productRelationshipPreview(productRelationshipProjectRef),
    tasks: productRelationshipPreview(productRelationshipTaskOut).extend({
      openCount: z.number().int().nonnegative(),
    }),
  }),
  derived: z.object({
    purchasedForProjects: productRelationshipPreview(
      productRelationshipProjectRef,
    ).extend({ unassignedExpenseCount: z.number().int().nonnegative() }),
    vendors: productRelationshipPreview(
      productRelationshipEntityRef(vendorShortcode),
    ),
  }),
});
export type ProductRelationshipRouteOut = z.infer<
  typeof productRelationshipRouteOut
>;

export const productListItemOut = z.object({
  ...productTopLevelFields,
  unitMappings: z.array(unitMappingOut),
  ingredient: productIngredientOut.nullable(),
  inventoryEntry: z.array(productListInventoryEntryOut),
  expenseCount: z.number().int(),
  // Live `ProductComponent` edges where this product is the parent — non-zero
  // means it's a kit or multi-pack. Counts distinct components, not units: a
  // 4-pack stored as one edge with `quantity: 4` reads as 1.
  componentCount: z.number().int().nonnegative(),
  // Net basis: SUM(expense.cost) over this product's live expenses. Plain sum
  // IS the net basis here — negative rows (refunds, disposals) are real in
  // this ledger, so they telescope correctly. 0 for a product with no
  // expenses, never null.
  expenseTotal: money,
  purchaseDate: plainDate.nullable(),
  ...productQuantityFields,
});
export type ProductListItem = z.infer<typeof productListItemOut>;

/** Generic MCP entity list row with storage-only child identifiers removed. */
export const productListItemMcpEntityOut = productListItemOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
  unitMappings: z.array(productUnitMappingMcpEntityOut),
});

export const productWithFoodOut = z.object({
  ...productTopLevelFields,
  ingredient: productIngredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(productInventoryWithLocationOut),
  servingAsLocations: z.array(productLocationRefOut),
  /**
   * Live `ProductComponent` edges where this product is the parent — non-zero
   * means it is a kit or multi-pack. Counts distinct components, not units.
   *
   * Embedded here rather than read from `product.components` beside it, for the
   * reason `servingAsLocations` gives above: the hero decides its presence
   * stamp from this, and a stamp that flipped when a second query resolved
   * would contradict the Kit Components table while it loaded.
   */
  componentCount: z.number().int().nonnegative(),
  food: foodSummary.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  /** Live cookbooks whose physical copies are this product. */
  cookbooks: z.array(productCookbookRefOut),
  ...productQuantityFields,
});
export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

/** Generic MCP entity detail with storage-only child identifiers removed. */
export const productWithFoodMcpEntityOut = productWithFoodOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
  unitMappings: z.array(productUnitMappingMcpEntityOut),
  recipeUsages: z.array(recipeUsageMcpEntityOut),
});

/** Generic MCP create/update result with storage-only child identifiers removed. */
export const productTopLevelMcpEntityOut = productTopLevelOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
});

export const productWithFoodAndSideEffectsOut = z.object({
  ...productTopLevelFields,
  ingredient: productIngredientOut.nullable(),
  unitMappings: z.array(unitMappingOut),
  inventoryEntry: z.array(productInventoryWithLocationOut),
  servingAsLocations: z.array(productLocationRefOut),
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

export const productTagOptionsOut = z.array(
  z.object({
    tag: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type ProductTagOptionsOut = z.infer<typeof productTagOptionsOut>;

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
          ancestors: z.array(locationAncestorOut),
          /** Distinct sibling products stocked here, never the viewed one. */
          productCount: z.number().int().positive(),
          holdsSource: z.boolean(),
        }),
      ),
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

export const productQuickCreatePayload = z.object({
  name: requiredName("Product name"),
  manufacturer: z.string().default(UNSPECIFIED_MANUFACTURER),
  upc: gtin.nullable().optional(),
  isbn: isbn.nullable().optional(),
  expectedQuantity: z.number().int().positive().nullable().optional(),
  model: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  price: positiveMoneyNullable.optional(),
  category: productCategory.nullable().optional(),
});

export type ProductQuickCreatePayload = z.infer<
  typeof productQuickCreatePayload
>;

export const mcpProductCreateInput = z.object({
  name: requiredName("Product name")
    .describe("Product name")
    .meta({ mock: "commerce.productName" }),
  // Nullish, not nullable: a bare `.nullable()` still makes the KEY required,
  // so creating a product with no barcode meant sending an explicit `null` —
  // and an MCP client that surfaces this as a plain string field cannot express
  // one, which made a Product with no UPC uncreatable over MCP. That is the
  // ordinary case for a kit parent or a retailer composite, neither of which
  // carries a barcode. `mcpProductUpdateInput` already had both fields
  // optional; create is what diverged.
  upc: gtin.nullish(),
  isbn: isbn
    .nullish()
    .describe(
      "Physical-book ISBN-10 or ISBN-13; stored in the canonical GTIN identifier slot",
    ),
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
    .nullish()
    .describe(
      "Link this product to an ingredient (its id) so recipes using that ingredient can cost from this product.",
    ),
  price: positiveMoneyNullable
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
  aliases: z
    .array(z.string())
    .optional()
    .describe("Alternate names (replaces the existing list)"),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Compatibility/grouping tags, e.g. "grinder-4.5in" or "M18" (replaces the existing list). Tag a tool and the consumables that fit it with the same value; `category` distinguishes which is which.',
    ),
  externalIds: externalIdValues
    .optional()
    .describe(
      "Retailer/vendor identifiers. Pass the COMPLETE desired set: it replaces the existing list. A (source, kind) slot takes one PRIMARY plus any number of secondaries — mark the extras isPrimary: false.",
    ),
  upc: gtin.nullable().optional(),
  isbn: isbn
    .nullable()
    .optional()
    .describe(
      "Physical-book ISBN-10 or ISBN-13; null retires the primary book barcode",
    ),
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
  price: positiveMoneyNullable.optional(),
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
    .array(imageShortcode)
    .optional()
    .describe(
      "Product image ids (`IMG-` codes, as returned by attach_file and get_product) to detach; an id not currently attached to this product is silently ignored. Detaching DELETES the stored file when nothing else references it — there is no restore.",
    ),
  imageOrder: z
    .array(imageShortcode)
    .optional()
    .describe("Product image ids in display order; first valid image is cover"),
});

const productMcpFields = {
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  primaryGtin: gtin.nullable(),
  category: productCategory.nullable(),
  tags: z.array(z.string()),
  /**
   * Hand-written rather than picked from `productTopLevelOut`: this shape adds
   * `effectivePrice` alongside `price`, and the two must keep the SAME meaning
   * their `productTopLevelOut`/`productPricingOut` counterparts have.
   */
  price: moneyNullable.describe(
    "Manual per-item valuation/replacement-price override, exactly as stored; null means no override and `effectivePrice` falls back to the Expense-derived value.",
  ),
  effectivePrice: moneyNullable.describe(
    "Resolved valuation/costing price: the manual `price` override when set, else the Expense-derived price. Same number as `pricing.effectivePrice` — this is what values stock and costs recipes.",
  ),
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
  // `imageShortcode`, not a uuid: images carry public `IMG-` codes now, so the
  // MCP boundary no longer needs an image exception.
  id: imageShortcode,
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

export const productMcpDetailOut = z.object({
  ...productMcpFields,
  coverImageId: imageShortcode.nullable(),
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
        /**
         * `unique` means one live owner — but not necessarily the product you
         * asked about, which is how three duplicate pairs were nearly missed in
         * one import session. Pass `productId` and the answer splits into
         * `owned_by_this` and `owned_by_other`; without it the vocabulary is
         * unchanged.
         */
        status: z.enum([
          "missing",
          "unique",
          "owned_by_this",
          "owned_by_other",
          "collision",
        ]),
        products: z.array(z.object({ id: productShortcode, name: z.string() })),
      }),
    )
    .default([]),
});

export const productExternalIdCollisionInput = z
  .object({
    source: z.union([externalIdSource, z.array(externalIdSource)]).optional(),
    productId: productShortcode.optional(),
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
          isPrimary: z.boolean().optional(),
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
    // Scoped to the VALUE, not the slot: a slot holds one primary and any
    // number of secondaries, so patching two of its rows in one call is
    // ordinary. What must stay unique is the row each entry addresses — and,
    // separately, the single primary.
    const addressed = new Set<string>();
    const primaries = new Set<string>();
    const slotOf = (entry: { source: string; kind: string }) =>
      `${entry.source.trim().toLowerCase()}\u0000${entry.kind}`;
    for (const entry of value.upsert) {
      const key = `${slotOf(entry)}\u0000${entry.externalId}`;
      if (addressed.has(key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each external ID may be patched only once",
        });
      addressed.add(key);
      if (entry.isPrimary === false) continue;
      if (primaries.has(slotOf(entry)))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Each external-ID slot may take only one PRIMARY per call; mark the others isPrimary: false",
        });
      primaries.add(slotOf(entry));
    }
    for (const entry of value.remove) {
      const key = `${slotOf(entry)}\u0000${entry.expectedExternalId}`;
      if (addressed.has(key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each external ID may be patched only once",
        });
      addressed.add(key);
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

export const productMergeSummaryOut = z.object({
  keepId: productShortcode,
  deletedIds: z.array(productShortcode),
  /**
   * Product rows the merge actually soft-deleted, read back from the write
   * itself (`finalizeMerge`) rather than assumed from `mergeIds.length` — a
   * count that would only ever quote the request back at the caller.
   */
  merged: z.number().int().nonnegative(),
  externalIdsMoved: z.number().int(),
  externalIdsDemoted: z.array(
    z.object({
      source: z.string(),
      kind: externalIdKind,
      externalId: z.string(),
    }),
  ),

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
