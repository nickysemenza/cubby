import { tradeSchema } from "./task-fields";
import { productCategoryFeature } from "./product-category-fields";
import { productCategoryShortcode } from "./identifier-fields";
import { productTopLevelOut } from "./product-output-fields";
import { inventoryPlacementValues } from "@cubby/shared";
import { foodSummary, foodSummaryMcpOut, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { productRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  dateRangeFields,
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
import { money, moneyNullable, positiveMoneyNullable } from "./money";
import { externalIdKind, externalIdOut, externalIdSource } from "./external-id";
import {
  cookbookShortcode,
  expenseShortcode,
  imageShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import {
  imageOut,
  ImageRenderStatus,
  ImageStatus,
  ImageStorageStatus,
} from "./image";
import { displayImagesField } from "./display-images";
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
import { plainDate, taskStatusSchema } from "./project";
import { recipeUsageMcpEntityOut, recipeUsageOut } from "./recipe";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  generatedProductFieldSchemas,
  generatedProductFilterFields,
} from "./generated/entity-field-schemas.product.gen";
import {
  mcpUnitMappingOut,
  unitMappingOut,
  unitMappingWithMetadata,
} from "./unitmapping";
import { productCategory, productPricingOut } from "./product-fields";
import type { ProductCategorySummary } from "./product-category-fields";

export { productPricingOut } from "./product-fields";

export type ProductCategory = ProductCategorySummary;

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

export const productCreateInput = z.object(generatedProductFieldSchemas.create);
export const productUpdateData = z
  .object(generatedProductFieldSchemas.update)
  .extend({
    removeImageIds: z.array(imageShortcode).optional(),
    imageOrder: z.array(imageShortcode).optional(),
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

/**
 * `scan` carries a raw scanner string — a Cubby label (or label URL), a
 * barcode, or an ISBN — for the server to classify, so a native caller needs
 * no local shortcode/ISBN parsing. Rejected with the same messages the web
 * scanner shows when it names nothing stockable.
 */
export const productFindOrCreateByCodeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("barcode"), value: upc }),
  // Plain string: check-digit validation + GTIN-14 normalization now
  // happen in `product.findOrCreateByCode`'s "isbn" arm
  // (`apps/web/src/server/services/product-orchestration.service.ts`) —
  // `packages/schemas` cannot depend on the WASM boundary that needs.
  z.object({ kind: z.literal("isbn"), value: z.string().trim() }),
  z.object({ kind: z.literal("scan"), value: z.string().trim().min(1) }),
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

/**
 * Lookup-only name resolution for imports: "which of these receipt lines already
 * has a Product?" without minting anything. The ingredient twin
 * (`resolve_ingredients`) creates on miss because an ingredient is just a
 * name; a Product is identity plus cost basis, so the create stays a separate,
 * deliberate call after the agent has read the candidates.
 */
export const productResolveNamesInput = z.object({
  names: z.array(z.string().min(1)).min(1).max(200),
});
export type ProductResolveNamesInput = z.infer<typeof productResolveNamesInput>;

export const productResolveCandidateOut = z.object({
  id: productShortcode,
  name: generatedProductFieldSchemas.read.name,
  manufacturer: generatedProductFieldSchemas.read.manufacturer,
  category: generatedProductFieldSchemas.read.category,
  // Same value-space narrowing as `productPickerItemOut.price` — the
  // candidates ARE picker rows.
  price: positiveMoneyNullable,
  coverImageUrl: z.string().nullable(),
});
export type ProductResolveCandidateOut = z.infer<
  typeof productResolveCandidateOut
>;

export const productResolveNameOut = z.object({
  /** The requested name, trimmed, as the caller sent it. */
  name: z.string(),
  /**
   * True when `candidates` are case-insensitive name/alias equals. False means
   * the candidates come from a contains search and need a human read.
   */
  exact: z.boolean(),
  candidates: z.array(productResolveCandidateOut),
});
export const productResolveNamesOut = z.array(productResolveNameOut);
export type ProductResolveNamesOut = z.infer<typeof productResolveNamesOut>;

export const productMarkUsdaUnavailableManyInput = z.object({
  ids: z.array(productShortcode).min(1).max(100),
});

export const productFilterFields = {
  ...auditDateFilterFields,
  ...productRelatedFilterFields,
  ...generatedProductFilterFields,
  /** Components of the given kit(s): products on their `ProductComponent` rows. */
  kitId: oneOrMany(productShortcode).optional(),
  upcPresenceFilter: presenceFilter,
  externalIdSource: oneOrMany(externalIdSource).optional(),
  externalIdPresenceFilter: presenceFilter,
  dataStatus: dataQualityStatus.optional(),
  dataGap: oneOrMany(productDataCheck).optional(),
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
  growsIngredientIdFilter: entityFilterList(ingredientShortcode).optional(),
  taskStatusFilter: oneOrMany(taskStatusSchema).optional(),
  taskOpenOnly: z.boolean().optional(),
  ...dateRangeFields("taskDue"),
  /**
   * `"none"` is the untagged worklist. Unlike `recipe.tags`, `product.tags` is
   * `notNull` with a `'{}'` default, so empty is the only untagged state —
   * `cardinality(tags) = 0`, no `IS NULL` half. OR-ed with `tagFilters` rather
   * than narrowing it (see `taskFilterFields.projectPresenceFilter`).
   */
  tagsPresenceFilter: presenceFilter,
  categoryFilter: oneOrMany(productCategoryShortcode).optional(),
  categoryFeatureFilter: oneOrMany(productCategoryFeature).optional(),
  categoryPresenceFilter: presenceFilter,
  expensePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have at least one expense in the ledger. Both acquisitions and exits (negative rows) count.",
  ),
  ...numericRangeFields("expenseCount", { int: true, nonnegative: true }),
  ...numericRangeFields("expenseTotal"),
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
   * neither recoverable. A `labelNutrition` override counts as "has" outright
   * — it supersedes the USDA lookup rather than keying it, so a labelled
   * product is present even with neither `fdc_id` nor a barcode.
   */
  usdaPresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have a USDA lookup key (an explicit fdc_id, a UPC to auto-match, or a label nutrition override). NOT whether USDA actually resolves a food for that key.",
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

// `expectedQuantity` and `quantityVariance` (units bought minus units gone,
// and shelf minus that) are correlated subqueries in
// repo/product/quantity-ledger.ts. Their sort keys must stay identical to the
// column ids in productlist.tsx, or `buildOrderBy` drops the sort while the
// header still renders a sort affordance.
export type ProductSortField = GeneratedEntitySortField<"product">;

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
  trade: tradeSchema,
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

export type ProductPricingOut = z.infer<typeof productPricingOut>;

const productTopLevelFields = generatedProductFieldSchemas.read;

export { productTopLevelOut };

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
  // Derived cover, same rule as `productTopLevelOut` (the mapper always emits it).
  coverImageUrl: z.url().nullable(),
  unitMappings: z.array(unitMappingOut),
});
export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

export const productWithMappingsAndFoodOut = z.object({
  ...productTopLevelFields,
  coverImageUrl: z.url().nullable(),
  unitMappings: z.array(unitMappingOut),
  food: foodSummary.nullable(),
});
export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;

const productExternalIdMcpEntityOut = externalIdOut.omit({ id: true });
/**
 * Declared exception: a unit-mapping row's `id` is the ONLY handle
 * `syncProductUnitMappings` (repo/product/update-helpers.ts) accepts to update
 * an existing row in place — a mapping resent without it is hard-deleted and
 * reinserted, losing `createdAt`/`updatedAt` and its audit trail. External-id
 * rows have their own slot-addressed patch tool (`patch_product_external_ids`)
 * and stay id-less, but a unit mapping has no such tool, so this child row
 * keeps its raw uuid across the MCP boundary — the same "id is the follow-up
 * write handle" carve-out as mealRecipe `id` and recipe section `lineId` (see
 * MCP_SERVER_INSTRUCTIONS in apps/web/src/server/mcp/server.ts).
 */
const productUnitMappingMcpEntityOut = unitMappingOut;

/** Product references embedded in MCP entity results never expose child-row ids, except unit mappings — see `productUnitMappingMcpEntityOut`. */
export const productWithMappingsMcpEntityOut = productWithMappingsOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
  unitMappings: z.array(productUnitMappingMcpEntityOut),
});

export const productWithMappingsAndFoodMcpEntityOut =
  productWithMappingsAndFoodOut.extend({
    externalIds: z.array(productExternalIdMcpEntityOut),
    unitMappings: z.array(productUnitMappingMcpEntityOut),
    food: foodSummaryMcpOut.nullable(),
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
  // Same derived cover rule as `productTopLevelOut`/the picker (see
  // `getProductCoverImageUrlsByProductIds`) — not a stored field.
  coverImageUrl: z.url().nullable(),
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

export const productUnitPriceMappings = z
  .array(unitMappingWithMetadata)
  .default([]);
export const productDataGaps = z.array(productDataCheck);

export const productListItemOut = z.object({
  ...productTopLevelFields,
  displayImages: displayImagesField,
  unitMappings: z.array(unitMappingOut),
  unitPriceMappings: productUnitPriceMappings,
  unitPrice: z
    .object({
      natural: z.object({ price: z.number(), unit: z.string() }).nullable(),
      perGram: z.number().nullable(),
    })
    .nullable()
    .default(null),
  food: foodSummary.nullable().default(null),
  modelPresence: z.boolean(),
  upcPresence: z.boolean(),
  notesPresence: z.boolean(),
  dataGaps: productDataGaps,
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
  food: foodSummaryMcpOut.nullable(),
});

export const productWithFoodOut = z.object({
  ...productTopLevelFields,
  // Same derived cover rule as `productTopLevelOut`/the picker (see
  // `getProductCoverImageUrlsByProductIds`) — not a stored field.
  coverImageUrl: z.url().nullable(),
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
  food: foodSummaryMcpOut.nullable(),
});

/** Generic MCP create/update result with storage-only child identifiers removed. */
export const productTopLevelMcpEntityOut = productTopLevelOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
});

export const productWithFoodAndSideEffectsOut = z.object({
  ...productTopLevelFields,
  // Same derived cover rule as `productTopLevelOut`/the picker (see
  // `getProductCoverImageUrlsByProductIds`) — not a stored field. Required so
  // this shape stays assignable to `productTopLevelOut` for the generic
  // entity kernel's create/update output typing.
  coverImageUrl: z.url().nullable(),
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
  // `name` deliberately diverges from the generated create field (see
  // INTENTIONAL_RESPELLINGS in field-map-drift.unit.test.ts): quick-create
  // keeps its own label.
  name: requiredName("Product name"),
  // `expectedQuantity` deliberately tightens the generated create field (also
  // registered) to a positive integer.
  expectedQuantity: z.number().int().positive().nullable().optional(),
  // These are unchanged copies of the generated create field — reference it
  // directly rather than re-declaring the same schema.
  manufacturer: generatedProductFieldSchemas.create.manufacturer,
  upc: generatedProductFieldSchemas.create.upc,
  isbn: generatedProductFieldSchemas.create.isbn,
  model: generatedProductFieldSchemas.create.model,
  notes: generatedProductFieldSchemas.create.notes,
  price: generatedProductFieldSchemas.create.price,
  categoryId: generatedProductFieldSchemas.create.categoryId,
});

export type ProductQuickCreatePayload = z.infer<
  typeof productQuickCreatePayload
>;

const productMcpFields = {
  id: productShortcode,
  name: generatedProductFieldSchemas.read.name,
  manufacturer: generatedProductFieldSchemas.read.manufacturer,
  model: generatedProductFieldSchemas.read.model,
  notes: generatedProductFieldSchemas.read.notes,
  primaryGtin: generatedProductFieldSchemas.read.primaryGtin,
  category: generatedProductFieldSchemas.read.category,
  tags: generatedProductFieldSchemas.read.tags,
  /**
   * Hand-written rather than referencing `generatedProductFieldSchemas.read.
   * price` directly: this shape adds `effectivePrice` alongside `price`, and
   * documents the pairing in its own `.describe()` — see
   * INTENTIONAL_RESPELLINGS in field-map-drift.unit.test.ts. The MEANING
   * still matches `productTopLevelOut`/`productPricingOut`'s counterparts.
   */
  price: moneyNullable.describe(
    "Manual per-item valuation/replacement-price override, exactly as stored; null means no override and `effectivePrice` falls back to the Expense-derived value.",
  ),
  effectivePrice: moneyNullable.describe(
    "Resolved valuation/costing price: the manual `price` override when set, else the Expense-derived price. Same number as `pricing.effectivePrice` — this is what values stock and costs recipes.",
  ),
  pricing: productPricingOut,
  // Stricter than the generated read field (`z.number().nullable()`, no
  // int/positive) — registered in INTENTIONAL_RESPELLINGS.
  expectedQuantity: z.number().int().positive().nullable(),
  imageCount: z.number().int().nonnegative(),
  /** Counts every active attachment in its role, including PDFs and files that
   * cannot currently render. Together these sum to imageCount. */
  itemImageCount: generatedProductFieldSchemas.read.itemImageCount,
  labelImageCount: generatedProductFieldSchemas.read.labelImageCount,
  coverImageUrl: z.url().nullable(),
  fdc_id: generatedProductFieldSchemas.read.fdc_id,
  usdaUnavailable: generatedProductFieldSchemas.read.usdaUnavailable,
  stockTracked: generatedProductFieldSchemas.read.stockTracked,
  // A slimmer MCP-facing projection of `externalIdOut` (no raw `id`/
  // `isPrimary`) — registered in INTENTIONAL_RESPELLINGS.
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
  // `ingredientId` has no generated *read* field (readKey: null on the
  // entity); this reuses the generated *create* field, which carries the
  // same nullable-shortcode meaning.
  ingredientId: generatedProductFieldSchemas.create.ingredientId,
  // Output-shaped (`mcpUnitMappingOut`), unlike the generated create/update
  // field's input shape (`unitMappingInput`) — registered in
  // INTENTIONAL_RESPELLINGS.
  unitMappings: z.array(mcpUnitMappingOut),
  labelNutrition: generatedProductFieldSchemas.read.labelNutrition,
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
  source: imageOut.shape.source,
  sourcePageUrl: imageOut.shape.sourcePageUrl,
  sourceAssetUrl: imageOut.shape.sourceAssetUrl,
  sourceName: imageOut.shape.sourceName,
  useOriginal: imageOut.shape.useOriginal,
  /** The ProductImage join role; null is distinct from an explicit item role. */
  purpose: z.enum(["item", "label"]).nullable(),
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
