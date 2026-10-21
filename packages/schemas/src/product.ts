import productDefinition from "./entity-definitions/00-product.entity";
import {
  productQuantityLedgerOut,
  productCookbookRefOut,
  productQuantityFields,
  productListInventoryEntryOut,
  productInventoryWithLocationOut,
  productIngredientOut,
  productLocationRefOut,
} from "./product-read-fields";
export {
  productQuantityLedgerOut,
  productCookbookRefOut,
  productQuantityFields,
  productListInventoryEntryOut,
  productUnitPriceMappings,
  productOwnershipEvidenceOut,
  productNutritionDisplay,
  type ProductQuantityLedgerOut,
  type ProductCookbookRefOut,
  type ProductListInventoryEntryOut,
  type ProductOwnershipEvidenceOut,
  type ProductNutritionDisplay,
} from "./product-read-fields";
import { tradeSchema } from "./task-fields";
import { impliedClassification } from "./classification-field-policy";
import {
  productCategoryFeature,
  type ProductCategoryFeature,
} from "./product-category-fields";
import {
  productTopLevelOut,
  productWithMappingsOut,
  productWithMappingsAndFoodOut,
} from "./product-output-fields";
import { upc } from "@cubby/shared/upc";
import { foodSummary, foodSummaryCompact } from "@cubby/usda";
import { z } from "zod";
import { locationRefOut } from "./location-fields";
import { productRefOut } from "./product-fields";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { dateBound, dateRangeFields, numericRangeFields } from "./base-entity";
import { amount } from "./codec";
import { requiredName } from "./common";
import { moneyNullable, positiveMoneyNullable } from "./money";
import { externalIdKind, externalIdOut, externalIdSource } from "./external-id";
import {
  expenseShortcode,
  imageShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import {
  imageOut,
  imageAnalysisSummarySchema,
  productImagePurpose,
} from "./image";
import { locationAncestorOut } from "./location";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { plainDate, taskStatusSchema } from "./project";
import { recipeUsageMcpEntityOut, recipeUsageOut } from "./recipe";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import { generatedProductFieldSchemas } from "./generated/entity-field-schemas.product.gen";
import {
  mcpUnitMappingOut,
  unitMappingOut,
  unitMappingWithMetadata,
} from "./unitmapping";
import { productCategory, productPricingOut } from "./product-fields";
import type { ProductCategorySummary } from "./product-category-fields";
import {
  productBaseFilterFields,
  productCreateInput,
} from "./generated/product.gen";

export {
  productCreateInput,
  productUpdateData,
  productUpdateInput,
  type ProductCreateInput,
  type ProductUpdateInput,
} from "./generated/product.gen";

export { productPricingOut } from "./product-fields";

export type ProductCategory = ProductCategorySummary;

/**
 * The explicit USDA food link: a positive `fdc_id`. One definition shared by
 * {@link impliedProductFeature} and the problems repo's food-category
 * detector, so "what counts as an fdc link" can't drift between them.
 */
export const hasFdcLink = (fdc_id: number | null | undefined): boolean =>
  fdc_id != null && fdc_id > 0;

/**
 * The category feature a Product's identity evidence implies, read from the
 * declared `productCategory.feature` field policy: an ingredient or USDA link
 * implies Food, an ISBN Books, food evidence first. Callers decide `hasIsbn`
 * from the external ids they hold.
 */
export const impliedProductFeature = (evidence: {
  fdc_id?: number | null;
  // Presence only: shared by the public shortcode form and the private UUID
  // repo boundary, so it deliberately accepts either shape.
  ingredientId?: string | null;
  hasIsbn?: boolean;
}): ProductCategoryFeature | null => {
  const present = new Set<"ingredientId" | "fdc_id" | "isbn">();
  if (evidence.ingredientId) present.add("ingredientId");
  if (hasFdcLink(evidence.fdc_id)) present.add("fdc_id");
  if (evidence.hasIsbn) present.add("isbn");
  return impliedClassification("productCategory.feature", present);
};

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

const productIdsBatchInput = z.object({
  ids: z.array(productShortcode).max(PRODUCT_QUANTITY_SUMMARY_BATCH_MAX),
});
export const productQuantitySummaryBatchInput = productIdsBatchInput;

/**
 * "Where does each of these products live" for a bounded set of ids — the
 * batch companion to `productQuantitySummaryBatchInput`.
 *
 * Shortcode-keyed rather than a field on the rows that need it: the callers are
 * tables whose row entity ISN'T a product (a task's subject product, say), and
 * threading stock onto those row shapes would make every other producer of them
 * emit an empty array it never loaded.
 */
export const productInventoryEntriesBatchInput = productIdsBatchInput;

export const productApplyUpcInput = z.object({
  id: productShortcode,
  upc,
});

export const productFindOrCreateByUPCInput = z.object({
  upc,
  defaultName: z
    .string()
    .optional()
    .describe("Fallback name if not found in any database"),
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
  // (`apps/web/src/server/domains/product/repo/write/product-orchestration.ts`) —
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
 * (`entity.resolve`) creates on miss because an ingredient is just a
 * name; a Product is identity plus cost basis, so the create stays a separate,
 * deliberate call after the agent has read the candidates.
 */
export const productResolveLineInput = z.object({
  name: z.string().trim().min(1),
  externalIds: z
    .array(
      z.object({
        source: externalIdSource.describe(
          "Provider slug the id belongs to (e.g. 'amazon', 'amazon-fresh', 'whole-foods'); the same ASIN under another source is not a hit.",
        ),
        id: z.string().trim().min(1),
      }),
    )
    .max(10)
    .optional()
    .describe("Identifiers of this line, matched exactly under their source."),
});
export type ProductResolveLineInput = z.infer<typeof productResolveLineInput>;

/** `names` and `lines` together carry at least 1 and at most 200 entries. */
export const productResolveNamesInput = z.object({
  names: z.array(z.string().min(1)).max(200).optional(),
  lines: z.array(productResolveLineInput).max(200).optional(),
});
export type ProductResolveNamesInput = z.infer<typeof productResolveNamesInput>;

export const productResolveCandidateOut = z.object({
  id: productShortcode,
  name: productTopLevelOut.shape.name,
  manufacturer: productTopLevelOut.shape.manufacturer,
  category: productTopLevelOut.shape.category,
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
  /** Live Products holding any of the line's `(source, id)` pairs; empty for a bare name. */
  exactIdHits: z.array(productResolveCandidateOut),
  /** Ingredients whose name or alias equals the requested name, case-insensitively. */
  ingredientHits: z.array(
    z.object({ id: ingredientShortcode, name: z.string() }),
  ),
});
export const productResolveNamesOut = z.array(productResolveNameOut);
export type ProductResolveNamesOut = z.infer<typeof productResolveNamesOut>;

export const productMarkUsdaUnavailableManyInput = z.object({
  ids: z.array(productShortcode).min(1).max(100),
});

export const productFilterFields = {
  ...productBaseFilterFields,
  /** Components of the given kit(s): products on their `productComponent` links. */
  kitId: oneOrMany(productShortcode).optional(),
  /** Kits containing the given component(s): the parents on their `productComponent` links. */
  componentId: oneOrMany(productShortcode).optional(),
  upcPresenceFilter: presenceFilter,
  externalIdSource: oneOrMany(externalIdSource).optional(),
  inventoryMultiplicity: z
    .boolean()
    .optional()
    .describe(
      "Products expected once but recorded more than once within stock or installed placement.",
    ),
  ownershipReconciliation: z
    .boolean()
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
    .boolean()
    .optional()
    .describe(
      "Kits stocked as themselves AND as their components, together accounting for more units than the ledger says were acquired.",
    ),
  conversionCoverage: z
    .boolean()
    .optional()
    .describe("Products whose persisted conversion coverage is partial."),
  conversionTopology: z
    .boolean()
    .optional()
    .describe(
      "Products whose persisted conversion graph has multiple islands.",
    ),
  /**
   * Whether any Location IS this product — a bin, tote or rack in service,
   * rather than stock held on a shelf.
   *
   * Separate from `locationPresenceFilter` on purpose: the two are different
   * kinds of presence, and "Not on a shelf" means neither of them.
   */
  servingAsLocationPresenceFilter: presenceFilter.describe(
    "Filter to products that are / aren't in service as a Location.",
  ),
  taskStatusFilter: oneOrMany(taskStatusSchema).optional(),
  ...dateRangeFields("taskDue"),
  categoryFeatureFilter: oneOrMany(productCategoryFeature).optional(),
  expensePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have at least one expense in the ledger. Both acquisitions and exits (negative rows) count.",
  ),
  ...numericRangeFields("expenseCount", { int: true, nonnegative: true }),
  ...numericRangeFields("expenseTotal"),
  unknownQuantityLinesFilter: presenceFilter,
  purchaseDatePresenceFilter: presenceFilter.describe(
    "Filter to products that do / don't have a dated live Purchase linked through an Expense.",
  ),
  purchaseDateFrom: dateBound
    .optional()
    .describe("Match a product with any linked Purchase on or after this date"),
  purchaseDateTo: dateBound
    .optional()
    .describe(
      "Match a product with any linked Purchase on or before this date",
    ),
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
  // `stockTrackedPresenceFilter` is derived from its manifest descriptor and
  // matches the EFFECTIVE decision (the Product's own, else its category's):
  // `"none"` is the undecided worklist, `"has"` decided either way.
};

export const productFiltersSchema = z.object(productFilterFields);
export type ProductFilters = z.infer<typeof productFiltersSchema>;

export {
  productMovementKind,
  type ProductMovementKind,
} from "./product-movement-kind";

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
  date: plainDate.nullable().describe("Discard date; null when unknown."),
  reason: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .describe(
      "Free text stored as the Expense notes — broken, thrown away, given away.",
    ),
  /**
   * Inventory never auto-decrements (a binding tenet). Taking units off the
   * shelf is an explicit instruction on a screen that names the entry and the
   * count, so it is opt-IN: omitted means the shelf is left alone, and every
   * client sends this field explicitly. No other write path may take units off
   * a shelf as a side effect of money.
   */
  adjustInventory: z.boolean().default(false),
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

/**
 * Advisory preview of a discard, computed on the server so every client reads
 * one verdict. Never gates the discard: the mutation re-checks, and it
 * deliberately allows discarding more than the shelf holds.
 */
export const productDiscardPreviewInput = z.object({
  productId: productShortcode,
  quantity: z
    .number()
    .positive()
    .nullable()
    .default(null)
    .describe("Units about to be discarded; null while the quantity is unset."),
  adjustInventory: z.boolean().default(false),
  inventoryEntryId: inventoryShortcode.nullable().default(null),
  /** The quantity the caller wants prefilled (the triage proposes what the ledger expects). */
  requestedQuantity: z.number().positive().nullable().default(null),
});
export type ProductDiscardPreviewInput = z.infer<
  typeof productDiscardPreviewInput
>;

export const productDiscardPreviewOut = z.object({
  productName: z.string(),
  /** Live shelves the discard could draw from, oldest first. */
  shelves: z.array(
    z.object({
      id: inventoryShortcode,
      amount,
      location: locationRefOut,
    }),
  ),
  /** Not stocked anywhere: the discard only records the ledger exit. */
  ledgerOnly: z.boolean(),
  /** The shelf the discard will touch; null when none, or when a choice is owed. */
  selectedShelf: z
    .object({
      id: inventoryShortcode,
      amount,
      location: locationRefOut,
    })
    .nullable(),
  /**
   * Units to prefill: one, capped by the selected shelf so a part-used shelf
   * never proposes binning more than it holds.
   */
  defaultQuantity: z.number().positive(),
  /** Several shelves, shelf adjustment requested, none named — the server never guesses. */
  needsShelfChoice: z.boolean(),
  warning: z
    .object({
      tone: z.enum(["warning", "destructive"]),
      message: z.string(),
    })
    .nullable(),
});
export type ProductDiscardPreviewOut = z.infer<typeof productDiscardPreviewOut>;

/**
 * What "add to inventory" proposes and warns about for one product (optionally
 * at a location), so every client shows the server's verdict. Advisory only.
 */
export const productAddToInventoryPreviewInput = z.object({
  productId: productShortcode,
  locationId: locationShortcode.nullable().default(null),
});
export type ProductAddToInventoryPreviewInput = z.infer<
  typeof productAddToInventoryPreviewInput
>;

export const productAddToInventoryPreviewOut = z.object({
  /** The quantity the ledger says is outstanding, else one unit. */
  defaultAmount: amount,
  /** Parts on shelves already account for every unit bought. */
  kitWarning: z
    .object({ accounted: z.number(), expected: z.number() })
    .nullable(),
  /** Stock already at the location as display text (`3 each`); the add sums into that row. */
  existingAtLocationLabel: z.string().nullable(),
});
export type ProductAddToInventoryPreviewOut = z.infer<
  typeof productAddToInventoryPreviewOut
>;

export type ProductPricingOut = z.infer<typeof productPricingOut>;

const { coverImageUrl: _coverImageUrl, ...productTopLevelFields } =
  productTopLevelOut.shape;

export { productTopLevelOut };

/**
 * find-or-create result: the product plus whether it was newly created (vs a
 * match against an existing product). The scan UI prompts to link an ingredient
 * only when `created` — a brand-new UPC product lands with no ingredient link.
 */
export const productFindOrCreateByUPCOut = z.object({
  product: productTopLevelOut,
  created: z.boolean(),
  sideEffects: mutationSideEffectsSchema,
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

export {
  productWithMappingsOut,
  productWithMappingsAndFoodOut,
} from "./product-output-fields";
export type ProductWithMappingsOut = z.infer<typeof productWithMappingsOut>;

export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;

const productExternalIdMcpEntityOut = externalIdOut.omit({ id: true });
/**
 * Declared exception: a unit-mapping row's `id` is the ONLY handle
 * `syncProductUnitMappings` (repo/product/update-helpers.ts) accepts to update
 * an existing row in place — a mapping resent without it is hard-deleted and
 * reinserted, losing `createdAt`/`updatedAt` and its audit trail. External-id
 * rows are addressed by their identity in `entity.update` patch items and
 * stay id-less, but a unit mapping has no such key, so this child row
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
    food: foodSummaryCompact.nullable(),
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
  coverImageUrl: productTopLevelOut.shape.coverImageUrl,
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
   * Live `productComponent` links where this product is the parent — non-zero
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

/** Public product shortcode → its live stock entries and their locations. */
export const productInventoryEntriesByIdOut = z.record(
  z.string(),
  z.array(productListInventoryEntryOut),
);
export type ProductInventoryEntriesByIdOut = z.infer<
  typeof productInventoryEntriesByIdOut
>;

/** Generic MCP entity list row with storage-only child identifiers removed. */
export const productListItemOut = productDefinition.readSchemas.list;
export type ProductListItem = z.infer<typeof productListItemOut>;
export const productDataGaps = productListItemOut.shape.dataGaps;

export const productListItemMcpEntityOut = productListItemOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
  unitMappings: z.array(productUnitMappingMcpEntityOut),
  food: foodSummaryCompact.nullable(),
});

/** Generic MCP entity detail with storage-only child identifiers removed. */
export const productWithFoodOut = productDefinition.readSchemas.detail;
export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

export const productWithFoodMcpEntityOut = productWithFoodOut.extend({
  externalIds: z.array(productExternalIdMcpEntityOut),
  unitMappings: z.array(productUnitMappingMcpEntityOut),
  recipeUsages: z.array(recipeUsageMcpEntityOut),
  food: foodSummaryCompact.nullable(),
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
  coverImageUrl: productTopLevelOut.shape.coverImageUrl,
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

export const productMcpOut = z
  .object(productTopLevelFields)
  .pick({
    id: true,
    name: true,
    manufacturer: true,
    model: true,
    notes: true,
    primaryGtin: true,
    category: true,
    tags: true,
    price: true,
    pricing: true,
    fieldResolutions: true,
    expectedQuantity: true,
    itemImageCount: true,
    labelImageCount: true,
    fdc_id: true,
    usdaUnavailable: true,
    stockTracked: true,
    kind: true,
    labelNutrition: true,
    dataQuality: true,
  })
  .extend({
    effectivePrice: moneyNullable.describe(
      "Resolved valuation/costing price: the manual `price` override when set, else the Expense-derived price. Same number as `pricing.effectivePrice` — this is what values stock and costs recipes.",
    ),
    imageCount: z.number().int().nonnegative(),
    coverImageUrl: productTopLevelOut.shape.coverImageUrl,
    externalIds: z.array(productExternalIdMcpEntityOut),
    // USDA FoodData Central id — declared exception, not a cubby shortcode.
    usdaFdcId: z.number().nullable(),
    // No generated read field (the declaration has no read key for it).
    ingredientId: generatedProductFieldSchemas.create.ingredientId,
    unitMappings: z.array(mcpUnitMappingOut),
  });
export type ProductMcpOut = z.infer<typeof productMcpOut>;

export const productMcpImageOut = imageOut
  .pick({
    id: true,
    url: true,
    key: true,
    filename: true,
    size: true,
    contentType: true,
    status: true,
    width: true,
    height: true,
    detectedContentType: true,
    sha256: true,
    renderStatus: true,
    storageStatus: true,
    source: true,
    sourcePageUrl: true,
    sourceAssetUrl: true,
    sourceName: true,
    useOriginal: true,
    verifiedAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    /** The ProductImage join role; null is distinct from an explicit item role. */
    purpose: productImagePurpose.nullable(),
    displayPosition: z.number().int().positive().nullable(),
    isCover: z.boolean(),
    // Populated only on a Product detail/get read, not list, to keep list cost
    // flat — see `dbProductToAPI`/`splitProductImages`.
    analysisSummary: imageAnalysisSummarySchema.nullable().optional(),
  });

export const productMcpDetailOut = productMcpOut.extend({
  coverImageId: imageShortcode.nullable(),
  images: z.array(productMcpImageOut),
});
export type ProductMcpDetailOut = z.infer<typeof productMcpDetailOut>;

export const productMcpListOut = createPaginatedResponseSchema(productMcpOut);

/**
 * Exact identifier ownership. The live unique index on (source, kind,
 * externalId) means an identifier has at most one live owner, so there is no
 * "shared by two products" state to report.
 */
export const productExternalIdCollisionsOut = z.object({
  results: z.array(
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
      status: z.enum(["missing", "unique", "owned_by_this", "owned_by_other"]),
      products: z.array(productRefOut),
    }),
  ),
});

export const productExternalIdCollisionInput = z.object({
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
    .max(100),
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
