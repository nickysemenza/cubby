import { z } from "zod";
import { amount } from "./codec";
import { shortcodeEntities, type ShortcodeEntity } from "./entity-manifest";
import { referentialLivenessViolationSchema } from "./entity-integrity";
import {
  anyShortcodeSchema,
  financialAccountShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  plainDate,
  type ProjectAttentionType,
  projectAttentionItemSchema,
} from "./project";
import { searchableEntityRefFields, searchableEntitySchema } from "./search";

const publicEntityIdSchema = anyShortcodeSchema(
  shortcodeEntities as unknown as [ShortcodeEntity, ...ShortcodeEntity[]],
);

// The four base measurement kinds a product's conversion graph can reach. The
// single source for the BaseKind union: the costing lib (conversion-coverage)
// re-exports BASE_KINDS/BaseKind from this, and the coverage-bearing problem
// schemas below carry the union natively (no parallel repo type needed).
export const baseKind = z.enum(["weight", "volume", "money", "calories"]);
export type BaseKind = z.infer<typeof baseKind>;

// Shared field fragments — the product-summary head and the coverage shape
// repeat across many item schemas, so declare the reusable field maps once.
const productProblemFields = {
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
};
// `covered` = kinds the graph can actually reach; `applicable` = the kinds graded
// against (BASE_KINDS minus the ingredient's N/A opt-outs). A kind in `applicable`
// but not `covered` is a real gap; a kind in neither is "not applicable" (—).
const coverageFields = {
  covered: z.array(baseKind),
  applicable: z.array(baseKind),
};

// Output schemas for each problem type.
export const duplicateUniqueProductSchema = z.object({
  ...productProblemFields,
  expectedQuantity: z.number().nullable(),
  locations: z.array(
    z.object({
      id: locationShortcode,
      name: z.string(),
    }),
  ),
});

export const orphanedProductSchema = z.object({
  ...productProblemFields,
  createdAt: z.date(),
});

// A product that is stocked but carries no `price`, so its inventory entries
// value at nothing and the location rollup silently under-reports. Split into
// two sections rather than one: a `misc:` bucket is a heterogeneous pile with no
// meaningful unit price, so flagging it alongside real products would keep the
// section permanently red. Mirrors the miscNoPrice/missingPricing split the
// per-location valuation summary already makes.
export const productMissingPriceSchema = z.object({
  ...productProblemFields,
  // Total live inventory quantity — how much value is going unrecorded.
  inventoryQuantity: z.number(),
  locations: z.array(
    z.object({
      id: locationShortcode,
      name: z.string(),
    }),
  ),
});

// A product still sitting on a shelf after it was sold off. The disposal is
// already in the ledger — a Purchase whose Expenses are negative, the shape
// `purchaseSettlementKinds` documents — but inventory never auto-decrements
// (a binding tenet), so nothing walks the shelf back and the entry keeps
// valuing at the product's price. That is the exact mirror of
// `productsMissingPrice`: same location rollup, opposite failure. An unpriced
// product silently omits value; this one silently invents it.
//
// Keyed on a *disposal Purchase*, not merely a negative Expense line. Negative
// lines are common and mostly innocent — refunds, price adjustments, family
// contributions — and on live data that looser predicate is wrong about half
// the time (43 flagged, 20 real). Reported with both quantities so a partial
// sale reads as deliberate rather than as a bug.
export const soldButStillStockedSchema = z.object({
  ...productProblemFields,
  // Units accounted for by disposal lines. A line with no `productQuantity`
  // counts as one, matching how the ledger reads a bare sale row.
  soldQuantity: z.number(),
  // Units still on a shelf. Only reported when `soldQuantity >= liveQuantity`;
  // selling 4 of 14 parts bins leaves 10 legitimately stocked.
  liveQuantity: z.number(),
  // Net proceeds across those disposal lines (negative, as stored).
  proceeds: z.number(),
  locations: z.array(
    z.object({
      id: locationShortcode,
      name: z.string(),
    }),
  ),
});

// A recorded ProjectToolUsage edge for a tool we did not own while the project
// ran. The `trade_match` suggestion lane shipped without consulting ownership
// dates, so it drew candidates from the whole present-day tool shelf — for a
// 2020 project, 293 of the 295 inventoried tools were acquired after it ended.
// Suggestion and every write path now refuse these; this reports the ones that
// were already recorded before the gate existed.
//
// Converges to zero and each row is unambiguously wrong, but the fix is not
// always "detach": a tool bought before the ledger's coverage of it begins
// looks acquired-late, in which case the missing acquisition Expense is the
// real defect. Both dates ride along so the row says which.
export const toolUsedOutsideOwnershipSchema = z.object({
  ...productProblemFields,
  projectId: projectShortcode,
  projectName: z.string(),
  conflict: z.enum(["acquired_after_end", "disposed_before_start"]),
  /** The tool's first acquisition, or its last unreversed exit. */
  toolDate: plainDate,
  /** The project boundary it falls outside, grace already applied. */
  projectBoundary: plainDate,
});

// Two Product rows for one physical SKU, keyed on (manufacturer, model) with
// external ids from different sources — the cluster `merge_products` folds.
//
// Measured on the live 2,472-product catalog: 5 real duplicates found, ~6 false
// positives, every one a legitimate variant separated by a distinct UPC or a
// distinct retailer SKU (both of which the detector now suppresses on). Trigram
// name similarity was near-useless for the same job — see the detector's own
// header note before re-trying it.
export const duplicateProductIdentitySchema = z.object({
  manufacturer: z.string(),
  /** The maker part number the cluster shares. */
  model: z.string(),
  products: z.array(
    z.object({
      id: productShortcode,
      name: z.string(),
      upc: z.string().nullable(),
      /** Distinct external-id sources on this row (e.g. amazon, homedepot). */
      sources: z.array(z.string()),
    }),
  ),
});

export const productWithoutMappingsSchema = z.object({
  ...productProblemFields,
  createdAt: z.date(),
  isIngredient: z.boolean(),
  usdaUnavailable: z.boolean(),
  // The linked ingredient (null for non-food products), so the Problems card can
  // deep-link the ingredient-enrichment workbench to this exact row.
  ingredientId: ingredientShortcode.nullable(),
});

export const ingredientWithPartialCoverageSchema = z.object({
  ...productProblemFields,
  coverage: z.object(coverageFields),
  hasPrice: z.boolean(),
  hasUsdaLink: z.boolean(),
  usdaUnavailable: z.boolean(),
  // Always set here (these rows are ingredient products) — see above.
  ingredientId: ingredientShortcode,
});

/**
 * An ingredient a recipe uses but no product backs, so it can't be costed.
 *
 * Cookbook-imported recipes (`Recipe.cookbookId` set) don't count as usage —
 * an EPUB import contributes hundreds of ingredients nobody has committed to
 * cooking, and counting them buried the handful that actually block costing
 * something. `recipeCount` is therefore "how many of my own recipes need this".
 */
export const ingredientWithoutProductSchema = z.object({
  id: ingredientShortcode,
  name: z.string(),
  recipeCount: z.number(),
});

// An ingredient carrying ≥1 "unused" alias — one that's redundant (case-only dup
// of the name/another alias) or never matched by a recipe line. `aliases` is the
// full current list so the card can compute the keep-set; `unusedAliases` is the
// subset to strip (the delete removes only these, never the ingredient).
export const ingredientWithUnusedAliasesSchema = z.object({
  id: ingredientShortcode,
  name: z.string(),
  aliases: z.array(z.string()),
  unusedAliases: z.array(z.string()),
});

// An ingredient used in no live recipe (and not a sub-recipe pointer). `products`
// lists its non-deleted linked products ([] for the "no product" section); the
// delete removes those products too.
export const unusedIngredientSchema = z.object({
  id: ingredientShortcode,
  name: z.string(),
  createdAt: z.date(),
  products: z.array(z.object({ id: productShortcode, name: z.string() })),
});

export const emptyLocationSchema = z.object({
  id: locationShortcode,
  name: z.string(),
  type: z.string(),
  createdAt: z.date(),
  lastBulkInventory: z.date().nullable(),
  aiDescription: z.string().nullable(),
  firstImageUrl: z.string().nullable(),
  firstImageId: z.string().nullable(),
});

// --- Recount staleness (tenet 1: inventory truth is restored only by a
// deliberate recount, so an uncounted bin is unverified, not accurate). ---

/**
 * A location holding stock whose last recount is missing or older than
 * STALE_RECOUNT_DAYS. `itemCount` is the live entry count (the section shows
 * how much stock is riding on the stale number); `lastBulkInventory` is null
 * for never-recounted bins.
 */
export const staleLocationSchema = z.object({
  id: locationShortcode,
  name: z.string(),
  type: z.string(),
  itemCount: z.number(),
  lastBulkInventory: z.date().nullable(),
});

/**
 * A live inventory entry that has never been through a recount
 * (`verifiedAt IS NULL`). Exhaustive — the detector's old 25-row sample cap was
 * removed because it reported a fraction of the real population. Classed
 * `coverage`, so it renders as an "N of M verified" meter, not a red count.
 */
export const neverVerifiedInventorySchema = z.object({
  id: inventoryShortcode,
  amount,
  createdAt: z.date(),
  product: z.object({
    id: productShortcode,
    name: z.string(),
  }),
  location: z.object({
    id: locationShortcode,
    name: z.string(),
  }),
});

/**
 * A live inventory entry parked in the global "Unknown" location — the bucket
 * a scan/import drops something into when it has no home yet. Every one of
 * these is an unmade filing decision.
 */
export const unknownParkedItemSchema = z.object({
  id: inventoryShortcode,
  amount,
  createdAt: z.date(),
  product: z.object({
    id: productShortcode,
    name: z.string(),
  }),
  // Always the global Unknown, but carried per row so the section can offer the
  // same recount-session deep link the other recount detectors do — draining
  // Unknown is a recount rooted there.
  location: z.object({
    id: locationShortcode,
    name: z.string(),
  }),
});

/**
 * One spelling of a brand name that collides with a more-used spelling of the
 * same name — `RYOBI` where 12 other products say `Ryobi`.
 *
 * Reported for the free-text `Product.manufacturer` column. The row is per
 * VARIANT, not per record, so one card covers however many rows carry the
 * misspelling.
 */
const labelVariantFields = {
  /** The minority spelling, exactly as stored. */
  value: z.string(),
  /**
   * How much backs this spelling: products carrying it for a manufacturer, live
   * purchases pointing at it for a vendor (whose name is unique per row, so
   * counting rows there could never produce a majority).
   */
  count: z.number().int(),
  /** The most-used spelling sharing this canonical form. */
  canonical: z.string(),
  canonicalCount: z.number().int(),
};

export const labelVariantSchema = z.object({
  ...labelVariantFields,
  /** One product bearing the minority spelling. */
  sampleId: productShortcode,
});

/**
 * Two vendors on the roster whose names normalize to the same thing — `Amazon`
 * and `Amazon.com` are one real vendor entered twice, splitting that vendor's
 * spend across two rows.
 *
 * A {@link labelVariantSchema} row plus the CANONICAL row's own id, which the
 * manufacturer sibling has no use for. A manufacturer is a free-text string, so
 * its fix is a rename; these are two real `Vendor` rows and the fix is
 * `mergeVendors({ keepId, mergeIds })`, which needs an id for BOTH sides —
 * `canonical` is a name and `sampleId` is the VARIANT's id, so neither answers
 * "what do we keep".
 *
 * Its own contract over the shared field map rather than a field ON
 * `labelVariantSchema`, so the manufacturer detector's wire shape is untouched
 * (they share one SQL helper, so the column is selected for both and this schema's
 * absence of it is what strips it there). Both ids stay plain strings for the same
 * reason `sampleId` does — a branded schema's tRPC *input* type is `string`, so
 * the merge call needs no cast.
 */
export const duplicateVendorSchema = z.object({
  ...labelVariantFields,
  /** The vendor row carrying the minority spelling. */
  sampleId: vendorShortcode,
  /** The vendor row a merge would KEEP — the majority spelling. */
  canonicalSampleId: vendorShortcode,
});

/** Optional presentation coverage: an active vendor with no seeded mini logo. */
export const vendorWithoutLogoSchema = z.object({
  id: vendorShortcode,
  name: z.string(),
  website: z.string().nullable(),
  purchaseCount: z.number().int(),
  expenseRowCount: z.number().int(),
});

export const productWithNoImagesSchema = z.object({
  ...productProblemFields,
  upc: z.string().nullable(),
});

export const productWithIslandedMappingsSchema = z.object({
  ...productProblemFields,
  islandCount: z.number(),
  islands: z.array(
    z.object({
      units: z.array(z.string()),
      exampleUnit: z.string(),
    }),
  ),
  coverage: z.object(coverageFields),
});

export const locationWithoutAiDescriptionSchema = z.object({
  id: locationShortcode,
  name: z.string(),
  type: z.string(),
  imageCount: z.number(),
});

export const orphanedEntityEmbeddingSchema = z.object({
  // Permanent diagnostic exceptions: the embedding row itself is orphaned,
  // so its target UUID may have no live shortcode to expose.
  id: z.uuid(),
  entityType: searchableEntitySchema,
  entityId: z.uuid(),
  model: z.string(),
  createdAt: z.date(),
});

/**
 * A live entity with no embedding row under the current provider/model/dimensions
 * — invisible to semantic search until backfilled. The mirror image of
 * {@link orphanedEntityEmbeddingSchema}, and carries no id/model of its own
 * because there is no row yet.
 *
 * These rows are a SAMPLE (the detector caps them); `MaintenanceCounts.
 * entitiesMissingEmbeddings` carries the true figure.
 */
export const entityMissingEmbeddingSchema = z.object({
  ...searchableEntityRefFields,
  // Deliberately NOT hoisted onto `searchableEntityRefFields` itself (that type
  // is shared with `orphanedEntityEmbeddingSchema`, whose row points at an
  // entity that's been soft-deleted — there is no live row to resolve a
  // shortcode from, and inventing one would link to a 404). This half of the
  // pair points at a LIVE entity, so it can always be resolved and is safe to
  // link. Plain string, not a branded schema: `entityType` is one of ten
  // different entities, so no single branded type could be right for all of
  // them — mirrors why `entityId` above is also a plain string.
  entityId: publicEntityIdSchema,
});

// A live parent recipe whose persisted totals are marked fresh
// (`totalsComputedAt IS NOT NULL`) yet still reference — via a live section →
// link → sub-recipe ingredient — a soft-deleted sub-recipe. The escaped state
// the derived-data-on-removal guardrail catches: a removal path that skipped
// staleness propagation, or a dangling sub-recipe line the recipe still carries.
// Pure SQL (no WASM), so it rides the fast detector group.
export const staleParentRecipeSchema = z.object({
  id: recipeShortcode,
  name: z.string(),
});

export const staleIngredientParseSchema = z.object({
  // A RecipeSectionIngredient row id — an internal child row, not one of the
  // shortcode entities, so it stays a plain uuid string.
  recipeSectionIngredientId: z.string(),
  recipeId: recipeShortcode,
  recipeName: z.string(),
  ingredientId: ingredientShortcode,
  storedName: z.string(),
  rawLine: z.string(),
  parsedName: z.string(),
  nameDrift: z.boolean(),
  storedAmounts: z.array(amount),
  parsedAmounts: z.array(amount),
  amountDrift: z.boolean(),
  storedModifier: z.string().nullable(),
  parsedModifier: z.string().nullable(),
  modifierDrift: z.boolean(),
});

export const productWithBetterUpcDataSchema = z.object({
  ...productProblemFields,
  upc: z.string(),
  // Each field is set only when a fresh lookup would fill it (stored value empty
  // AND lookup has one). null ⇒ no change for that field. A row always has ≥1
  // non-null field. `imageUrl` is an absolute URL ready to render.
  proposed: z.object({
    manufacturer: z.string().nullable(),
    price: z.number().nullable(), // dollars, matches product.price + lookup.priceDollars
    imageUrl: z.string().nullable(),
  }),
});

/**
 * A purchase whose live expenses don't add up to its stated paperwork total.
 *
 * **Advisory, not a defect** — hence its non-defect `PROBLEM_CLASS`. `Purchase.
 * statedTotal` is what the paperwork claimed and is never summed into spend
 * (spend is `SUM(expense.cost)` = `expenseTotal` below). Differences exactly
 * explained by posted refunds are classified `refund_adjusted` and excluded;
 * the remaining disagreement is a cue to look, not a mechanically fixable fault.
 *
 * `statedTotal` is non-nullable here: a purchase with none recorded reconciles as
 * `"unknown"` and can't mismatch, so it never becomes a row. The delta is
 * deliberately NOT a field — `reconciliationDelta` already derives it from these
 * two numbers for the list column and the detail cue.
 */
export const purchaseNotReconcilingSchema = z.object({
  id: purchaseShortcode,
  /** Through the join; null only if the vendor was soft-deleted. */
  vendorName: z.string().nullable(),
  orderId: z.string().nullable(),
  date: plainDate.nullable(),
  /** What the paperwork claimed. Never spend. */
  statedTotal: z.number(),
  /** `SUM(cost)` over the purchase's live expenses — its real spend. */
  expenseTotal: z.number(),
  expenseCount: z.number().int(),
  unpricedExpenseCount: z.number().int(),
  /** Posted refund evidence used to distinguish explained differences. */
  postedRefundTotal: z.number(),
});

export const purchaseFinancialSettlementMismatchSchema = z.object({
  id: purchaseShortcode,
  vendorName: z.string().nullable(),
  expenseTotal: z.number(),
  financialReconciliation: z.object({
    status: z.literal("mismatch"),
    transactionCount: z.number().int(),
    postedTransactionCount: z.number().int(),
    outstandingTransactionCount: z.number().int(),
    postedTotal: z.number(),
    projectedTotal: z.number(),
    postedRefundTotal: z.number(),
    delta: z.number(),
  }),
});

export const duplicateFinancialTransactionSourceRefSchema = z.object({
  source: z.string(),
  externalId: z.string(),
  transactionIds: z.array(financialTransactionShortcode),
});

export const duplicateFinancialAccountSourceAliasSchema = z.object({
  source: z.string(),
  externalAccountId: z.string(),
  accountIds: z.array(financialAccountShortcode),
});

export const invalidFinancialJsonSchema = z.discriminatedUnion("entity", [
  z.object({
    entity: z.literal("financialAccount"),
    id: financialAccountShortcode,
    field: z.enum(["identity", "sourceAliases"]),
    message: z.string(),
  }),
  z.object({
    entity: z.literal("financialTransaction"),
    id: financialTransactionShortcode,
    field: z.literal("sourceRefs"),
    message: z.string(),
  }),
]);

// Grouped output shapes — the Problems page loads detectors in cost-grouped
// chunks (one tRPC query each, routed through an UNBATCHED link so each runs in
// its own Worker invocation/CPU budget; see root-provider.tsx). The groups split
// by cost: `fast` is all DB-only detectors; the rest isolate the heavier ones
// (USDA-coverage, UPC) so no single invocation sums all the CPU. The two WASM
// parse-sweeps (stale parses, unused aliases) are NOT here — they re-parse every
// recipe line and blew the CPU/memory budget on the request path, so they live as
// manual dry-run/fix-all actions in Settings → Maintenance instead.
const problemsFastShape = {
  duplicateInventory: z.array(duplicateUniqueProductSchema),
  duplicateProductIdentities: z.array(duplicateProductIdentitySchema),
  orphanedProducts: z.array(orphanedProductSchema),
  productsMissingPrice: z.array(productMissingPriceSchema),
  unvaluedBucketProducts: z.array(productMissingPriceSchema),
  soldButStillStocked: z.array(soldButStillStockedSchema),
  toolsUsedOutsideOwnership: z.array(toolUsedOutsideOwnershipSchema),
  productsWithoutMappings: z.array(productWithoutMappingsSchema),
  ingredientsWithoutProduct: z.array(ingredientWithoutProductSchema),
  unusedIngredientsWithProduct: z.array(unusedIngredientSchema),
  unusedIngredientsWithoutProduct: z.array(unusedIngredientSchema),
  emptyLocations: z.array(emptyLocationSchema),
  productsWithNoImages: z.array(productWithNoImagesSchema),
  locationsWithoutAiDescription: z.array(locationWithoutAiDescriptionSchema),
  orphanedEntityEmbeddings: z.array(orphanedEntityEmbeddingSchema),
  entitiesMissingEmbeddings: z.array(entityMissingEmbeddingSchema),
  staleParentRecipes: z.array(staleParentRecipeSchema),
  staleLocations: z.array(staleLocationSchema),
  neverVerifiedInventory: z.array(neverVerifiedInventorySchema),
  unknownParkedItems: z.array(unknownParkedItemSchema),
  manufacturerSpellingVariants: z.array(labelVariantSchema),
  duplicateVendors: z.array(duplicateVendorSchema),
  vendorsWithoutLogos: z.array(vendorWithoutLogoSchema),
  purchasesNotReconciling: z.array(purchaseNotReconcilingSchema),
  purchaseFinancialSettlementMismatches: z.array(
    purchaseFinancialSettlementMismatchSchema,
  ),
  duplicateFinancialTransactionSourceRefs: z.array(
    duplicateFinancialTransactionSourceRefSchema,
  ),
  duplicateFinancialAccountSourceAliases: z.array(
    duplicateFinancialAccountSourceAliasSchema,
  ),
  invalidFinancialJson: z.array(invalidFinancialJsonSchema),
  // A live row still pointing at a soft-deleted target — see
  // `findReferentialLivenessViolations`. DB-only and cheap (one UNION ALL over
  // 34 indexed FK joins), so it belongs in `fast` rather than earning its own
  // cost group: the expense is I/O, not the CPU the other groups isolate.
  referentialLivenessViolations: z.array(referentialLivenessViolationSchema),
};

// DB-only detectors — cheap, no WASM/network.
export const problemsFastSchema = z.object(problemsFastShape);

// USDA-coverage detectors — share one product scan + USDA enrichment.
const problemsCoverageShape = {
  ingredientsWithPartialCoverage: z.array(ingredientWithPartialCoverageSchema),
  productsWithIslandedMappings: z.array(productWithIslandedMappingsSchema),
};

export const problemsCoverageSchema = z.object(problemsCoverageShape);

// UPC-lookup network detector.
const problemsUpcShape = {
  productsWithBetterUpcData: z.array(productWithBetterUpcDataSchema),
};

export const problemsUpcSchema = z.object(problemsUpcShape);

// Household-tracker detectors (projects / tasks / expenses). Every row is a
// `ProjectAttentionItem` — the exact shape `computeAttentionItems` already
// produces for /projects?view=overview's Needs Attention, reused verbatim
// rather than restated. The flat item list is split per rule so each detector
// gets its own `problemsCount.byType` entry (and its own MCP `type` slice),
// like every other detector; the Problems page merges them back into one
// section with a subsection per rule. Cheap SQL — no WASM, no network — but its
// own cost group so it runs in its own Worker invocation like the rest.
const problemsTrackerShape = {
  overdueTasks: z.array(projectAttentionItemSchema),
  stalledProjects: z.array(projectAttentionItemSchema),
  projectsMissingBudget: z.array(projectAttentionItemSchema),
  pastDuePlannedExpenses: z.array(projectAttentionItemSchema),
  unclassifiedExpenses: z.array(projectAttentionItemSchema),
  blockedWorkProjects: z.array(projectAttentionItemSchema),
  projectsWithDateDrift: z.array(projectAttentionItemSchema),
};

export const problemsTrackerSchema = z.object(problemsTrackerShape);
export type ProblemsTracker = z.infer<typeof problemsTrackerSchema>;

/**
 * Attention rule type → the `ProblemsTracker` key its rows land in. The single
 * source for the service's split and the Problems page's per-rule grouping;
 * `satisfies` makes a new rule type a compile error until it has a slice.
 */
export const TRACKER_PROBLEM_KEY_BY_TYPE = {
  overdue_task: "overdueTasks",
  stalled_project: "stalledProjects",
  missing_budget: "projectsMissingBudget",
  past_due_planned_expense: "pastDuePlannedExpenses",
  unclassified_expense: "unclassifiedExpenses",
  blocked_work: "blockedWorkProjects",
  date_window_drift: "projectsWithDateDrift",
} as const satisfies Record<ProjectAttentionType, keyof ProblemsTracker>;

// Combined output schema for all problems. It intentionally spells out the wire
// contract while sharing the grouped shapes above, so lazy loading/cost grouping
// never makes fields appear optional on the aggregate response.
const allProblemArrayFields = {
  ...problemsFastShape,
  ...problemsCoverageShape,
  ...problemsUpcShape,
  ...problemsTrackerShape,
};

export const allProblemsSchema = z.object({
  ...allProblemArrayFields,
  totalProblems: z.number(),
});

export type ProblemKey = keyof typeof allProblemArrayFields;

/**
 * What kind of thing each detector reports. This is the axis the Problems page
 * splits on, and it is deliberately INDEPENDENT of the cost grouping above
 * (`fast`/`coverage`/`upc`/`tracker`) — those group by how expensive a detector
 * is to run, not by what its rows mean. `productsWithoutMappings` is a cheap
 * `fast` detector but a defect; `emptyLocations` is equally cheap but coverage.
 *
 *  - `defect`   — something is *wrong* and can be driven to zero. These are the
 *                 only rows that count toward `totalProblems` and the badge.
 *  - `coverage` — a measure of how much of the house has been through a manual
 *                 data-entry workflow (itemized, photographed, recounted). These
 *                 never reach zero: new things arrive faster than they get
 *                 filed, so counting them as problems produced a permanently red
 *                 badge nobody could act on. They render as progress meters.
 *
 * `coverage` is really "the non-defect bucket", and it carries one more kind of
 * row: ADVISORY cues, which are frequently correct exactly as they stand
 * (`purchasesNotReconciling` — a partial refund legitimately leaves a purchase's expenses
 * disagreeing with what its paperwork stated). Those aren't a data-entry backlog,
 * but the operative contract is the same one this class exists to express — not
 * wrong, never forced to zero, never in `totalProblems` or the badge, never
 * rendered in the defect red. They differ from a coverage backlog only in having
 * no meaningful denominator, which `unvaluedBucketProducts` already models.
 *
 * `satisfies` makes a newly-added detector a compile error until it is classed.
 */
export const PROBLEM_CLASS = {
  // --- defects: wrong data, converges to zero ---
  duplicateInventory: "defect",
  // Two rows for one SKU is unambiguously wrong — spend, stock, and identifiers
  // are split across both — and it converges to zero: `mergeProducts` folds the
  // cluster and the cluster never comes back. Same reasoning as
  // `duplicateVendors`. No auto-fix: which row survives decides which
  // identifiers and name stand, and there is no restore path.
  duplicateProductIdentities: "defect",
  orphanedProducts: "defect",
  productsMissingPrice: "defect",
  // Unambiguously wrong and converges to zero: the item was sold, so the shelf
  // is stale and the location total is overstated by its full value. Not
  // `coverage` — there is no denominator and no reported row is legitimately
  // correct as it stands. No auto-fix: the entry is usually stale but may
  // instead mean the disposal was mis-recorded, and deleting inventory has no
  // restore path.
  soldButStillStocked: "defect",
  // The edge asserts something that could not have happened, and the gate that
  // now rejects new ones means the list only shrinks. No auto-fix: detaching is
  // usually right, but a missing acquisition Expense produces the same row and
  // deleting the edge would bury the real defect.
  toolsUsedOutsideOwnership: "defect",
  productsWithoutMappings: "defect",
  unusedIngredientsWithProduct: "defect",
  unusedIngredientsWithoutProduct: "defect",
  locationsWithoutAiDescription: "defect",
  orphanedEntityEmbeddings: "defect",
  entitiesMissingEmbeddings: "defect",
  staleParentRecipes: "defect",
  unknownParkedItems: "defect",
  manufacturerSpellingVariants: "defect",
  // Two roster rows for one real vendor is simply wrong — that vendor's spend is
  // split across both — and it converges to zero: `mergeVendors` folds the pair
  // and the pair never comes back (the live roster sits at 0 across 114 vendors).
  // Not `coverage`: there is no backlog being worked through and no denominator,
  // and unlike `purchasesNotReconciling` a reported row is never legitimately
  // correct as it stands.
  duplicateVendors: "defect",
  // A dangling reference is unambiguously wrong and converges to zero — it can
  // only appear when a removal path forgets to detach, re-point, or cascade.
  // Production sat at zero when this detector landed, so any row is a real
  // regression rather than a backlog to work through. No auto-fix is offered:
  // clearing the FK and deleting the source row are both plausible and not
  // interchangeable, and picking wrong destroys data with no restore path.
  referentialLivenessViolations: "defect",
  ingredientsWithPartialCoverage: "defect",
  productsWithIslandedMappings: "defect",
  productsWithBetterUpcData: "defect",
  overdueTasks: "defect",
  stalledProjects: "defect",
  projectsMissingBudget: "defect",
  pastDuePlannedExpenses: "defect",
  unclassifiedExpenses: "defect",
  blockedWorkProjects: "defect",
  projectsWithDateDrift: "defect",

  // --- coverage: backlog size, never reaches zero ---
  // Misc buckets are *expected* to be unpriced — `findProductsMissingPrice`
  // already partitions them out for exactly this reason; classing them here is
  // what finally keeps them out of the total.
  unvaluedBucketProducts: "coverage",
  ingredientsWithoutProduct: "coverage",
  emptyLocations: "coverage",
  staleLocations: "coverage",
  neverVerifiedInventory: "coverage",
  productsWithNoImages: "coverage",
  vendorsWithoutLogos: "coverage",
  // Advisory, not backlog (see the note above): a purchase whose expenses disagree
  // with its stated total is often correct as-is, and the only mechanical "fix"
  // would be back-computing a cost from `statedTotal` — which nothing may do. So
  // it is reported, never counted, and never red.
  purchasesNotReconciling: "coverage",
  purchaseFinancialSettlementMismatches: "coverage",
  duplicateFinancialTransactionSourceRefs: "defect",
  duplicateFinancialAccountSourceAliases: "defect",
  invalidFinancialJson: "defect",
} as const satisfies Record<ProblemKey, "defect" | "coverage">;

const isDefectKey = (key: string): boolean =>
  PROBLEM_CLASS[key as ProblemKey] === "defect";

/**
 * Sum only the `defect` sections. The single definition of "how many problems
 * are there", shared by `assembleAllProblems` (MCP) and the Problems page's
 * client-side merge (`useProblemsData`, which is the navbar badge's real
 * source) — those two summed independently before this existed, so a change to
 * one silently diverged from the other.
 */
export const sumProblemSections = (
  sections: Record<string, readonly unknown[]>,
  problemClass: "defect" | "coverage",
): number =>
  Object.entries(sections).reduce(
    (n, [key, items]) =>
      isDefectKey(key) === (problemClass === "defect") ? n + items.length : n,
    0,
  );

// Count-only output schema for badge display. byType derives mechanically from
// allProblemsSchema — every array key becomes a count — so the count roster
// can't drift from the set of detectors (the runtime derives it the same way).
const byTypeShape = Object.fromEntries(
  Object.keys(allProblemArrayFields).map((k) => [k, z.number()]),
) as { [K in keyof typeof allProblemArrayFields]: z.ZodNumber };

export const problemsCountSchema = z.object({
  /** Defect rows only — what the navbar badge and homepage banner show. */
  total: z.number(),
  /** Coverage-backlog rows, reported separately so they never inflate `total`. */
  coverageTotal: z.number(),
  byType: z.object(byTypeShape),
});

/**
 * Denominators for the coverage meters — the "M" in "N of M photographed".
 *
 * Every detector returns only its failing rows, so a percentage needs a
 * population count that nothing else computes. Keyed by the coverage detector
 * each one pairs with, so a meter can't be wired to the wrong denominator.
 *
 * Deliberately its OWN schema and procedure rather than a field on
 * `problemsFastShape`: `allProblemArrayFields` must stay arrays-only, or the
 * mechanically-derived `byTypeShape` and `countProblems` both break on a
 * non-array key. `unvaluedBucketProducts` is absent on purpose — a misc bucket
 * has no meaningful population to be a fraction of, so it renders as a plain
 * list.
 */
export const coverageTotalsSchema = z.object({
  /** Live non-ingredient products (the ones a photo backfill could cover). */
  productsWithNoImages: z.number(),
  /** Live leaf locations — the only ones that can hold inventory directly. */
  emptyLocations: z.number(),
  /** Live locations currently holding stock. */
  staleLocations: z.number(),
  /** Live inventory entries. */
  neverVerifiedInventory: z.number(),
  /** Live ingredients referenced by at least one live recipe. */
  ingredientsWithoutProduct: z.number(),
  /** Live vendors referenced by at least one live purchase. */
  vendorsWithPurchases: z.number(),
});
export type CoverageTotals = z.infer<typeof coverageTotalsSchema>;

export type AllProblems = z.infer<typeof allProblemsSchema>;
export type ProblemsFast = z.infer<typeof problemsFastSchema>;
export type ProblemsCoverage = z.infer<typeof problemsCoverageSchema>;
export type ProblemsUpc = z.infer<typeof problemsUpcSchema>;
export type ProblemsCount = z.infer<typeof problemsCountSchema>;

// Derive the count payload from the full problems result: every array key
// becomes its length. The single source of truth for badge/count consumers, so
// they assemble the five cost-grouped queries and count locally (no re-scan).
export const countProblems = (all: AllProblems): ProblemsCount => {
  const { totalProblems, ...arrays } = all;
  const byType = Object.fromEntries(
    Object.entries(arrays).map(([key, items]) => [key, items.length]),
  ) as ProblemsCount["byType"];
  // `byType` stays the FULL roster (coverage keys included) so per-detector
  // consumers and the MCP `type` slices keep working; only the totals split.
  return {
    total: totalProblems,
    coverageTotal: sumProblemSections(arrays, "coverage"),
    byType,
  };
};

// Assemble the cost-grouped detector results into the combined AllProblems
// shape (with derived total). Shared by the service-layer findAllProblems
// aggregator and the MCP list_problems tool so the merge + total live in one
// place. (The Problems page merges client-side in useProblemsData, which is
// loading-aware and defaults not-yet-loaded groups to empty.)
export const assembleAllProblems = (groups: {
  fast: ProblemsFast;
  coverage: ProblemsCoverage;
  upc: ProblemsUpc;
  tracker: ProblemsTracker;
}): AllProblems => {
  const sections = {
    ...groups.fast,
    ...groups.coverage,
    ...groups.upc,
    ...groups.tracker,
  };
  return {
    ...sections,
    totalProblems: sumProblemSections(sections, "defect"),
  };
};

// Per-detector item types — the canonical shapes the problems repo's find*
// functions return, inferred from the schemas above so the repo never restates
// them. `coverage.covered` carries the BaseKind union natively (via baseKind).
export type DuplicateUniqueProduct = z.infer<
  typeof duplicateUniqueProductSchema
>;
export type OrphanedProduct = z.infer<typeof orphanedProductSchema>;
export type ProductMissingPrice = z.infer<typeof productMissingPriceSchema>;
export type SoldButStillStocked = z.infer<typeof soldButStillStockedSchema>;
export type ToolUsedOutsideOwnership = z.infer<
  typeof toolUsedOutsideOwnershipSchema
>;
export type DuplicateProductIdentity = z.infer<
  typeof duplicateProductIdentitySchema
>;
export type ProductWithoutMappings = z.infer<
  typeof productWithoutMappingsSchema
>;
export type IngredientWithPartialCoverage = z.infer<
  typeof ingredientWithPartialCoverageSchema
>;
export type IngredientWithoutProduct = z.infer<
  typeof ingredientWithoutProductSchema
>;
export type IngredientWithUnusedAliases = z.infer<
  typeof ingredientWithUnusedAliasesSchema
>;
export type UnusedIngredient = z.infer<typeof unusedIngredientSchema>;
export type EmptyLocation = z.infer<typeof emptyLocationSchema>;
export type StaleLocation = z.infer<typeof staleLocationSchema>;
export type NeverVerifiedInventory = z.infer<
  typeof neverVerifiedInventorySchema
>;
export type UnknownParkedItem = z.infer<typeof unknownParkedItemSchema>;
export type LabelVariant = z.infer<typeof labelVariantSchema>;
export type DuplicateVendor = z.infer<typeof duplicateVendorSchema>;
export type VendorWithoutLogo = z.infer<typeof vendorWithoutLogoSchema>;
export type ProductWithIslandedMappings = z.infer<
  typeof productWithIslandedMappingsSchema
>;
export type LocationWithoutAiDescription = z.infer<
  typeof locationWithoutAiDescriptionSchema
>;
export type StaleIngredientParse = z.infer<typeof staleIngredientParseSchema>;
export type StaleParentRecipe = z.infer<typeof staleParentRecipeSchema>;
export type ProductWithBetterUpcData = z.infer<
  typeof productWithBetterUpcDataSchema
>;
export type PurchaseNotReconciling = z.infer<
  typeof purchaseNotReconcilingSchema
>;
export type PurchaseFinancialSettlementMismatch = z.infer<
  typeof purchaseFinancialSettlementMismatchSchema
>;
export type DuplicateFinancialTransactionSourceRef = z.infer<
  typeof duplicateFinancialTransactionSourceRefSchema
>;
export type DuplicateFinancialAccountSourceAlias = z.infer<
  typeof duplicateFinancialAccountSourceAliasSchema
>;
export type InvalidFinancialJson = z.infer<typeof invalidFinancialJsonSchema>;
export type EntityMissingEmbedding = z.infer<
  typeof entityMissingEmbeddingSchema
>;

// Counts powering the Settings → Maintenance "N affected" dry-run. A focused
// subset (the batch tools shown there), kept separate from problemsCount so it
// can run only cheap DB/WASM detectors — no USDA/UPC network. Keys mirror the
// canonical `problemsCount.byType` names (a Pick of them) so the Maintenance row
// and the Problems section read the same field — no third naming convention.
export const maintenanceCountsSchema = z.object({
  productsWithNoImages: z.number().int(),
  locationsWithoutAiDescription: z.number().int(),
  // Active recipes whose persisted totals are stale (pending recompute). The
  // recompute queue normally drains these in seconds; a lingering count means a
  // wave was lost (DLQ) — recompute-all clears it.
  staleRecipeTotals: z.number().int(),
  // Unassociated PENDING image rows older than the cull threshold (24h) — the
  // abandoned-upload backlog the "Cull pending images" tool clears.
  cullablePendingImages: z.number().int(),
  // Live entities with no embedding under the current model. The TRUE figure —
  // the matching Problems section only carries a capped sample, so this is what
  // the auto-fix button counts. 0 when embeddings aren't configured.
  entitiesMissingEmbeddings: z.number().int(),
});
export type MaintenanceCounts = z.infer<typeof maintenanceCountsSchema>;

export const dryRunReparseOut = z.object({
  wouldChange: z.number().int(),
  total: z.number().int(),
});

export const dryRunPruneAliasesOut = z.object({
  wouldPrune: z.number().int(),
  ingredients: z.number().int(),
});

export const cleanupOrphanedEntityEmbeddingsInput = z
  .object({
    ids: z.array(z.uuid()).optional(),
  })
  .optional();

export const cleanupOrphanedEntityEmbeddingsOut = z.object({
  found: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});

export const recipeUsageByProductInput = z.object({
  productShortcodes: z.array(productShortcode),
});

/**
 * Keyed by product SHORTCODE, matching the input — the caller (a problem card)
 * only ever holds the public id, so a uuid-keyed map here would never match and
 * the "used in N recipes" signal would silently vanish from every card.
 */
export const recipeUsageByProductOut = z.record(z.string(), z.number());

export const deleteUnusedIngredientsInput = z.object({
  ingredientIds: z.array(ingredientShortcode),
  alsoDeleteProducts: z.boolean(),
});

export const deleteUnusedIngredientsOut = z.object({
  deleted: z.number(),
  failed: z.array(z.object({ id: ingredientShortcode, reason: z.string() })),
});
