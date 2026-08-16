import { z } from "zod";
import { amount } from "./codec";
import { shortcodeEntities, type ShortcodeEntity } from "./entity-manifest";
import { referentialLivenessViolationSchema } from "./entity-integrity";
import {
  anyShortcodeSchema,
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  mealShortcode,
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

// A product whose ledger says more units left than ever arrived.
//
// You cannot sell, return, or discard something you never acquired, so a
// negative expected quantity is unambiguously a data defect — a missing
// acquisition line, an acquisition whose quantity was never recorded, or an
// exit entered against the wrong product.
//
// Counts EVERY negative line as an exit, deliberately unlike its neighbour
// `soldButStillStocked`, which requires a disposal Purchase. That detector asks
// "was this sold off entirely?", where a refund is noise. This asks "do the
// units balance?", where a return of 8 boxes is 8 real units going back — and
// on live data returns and refunds are 218 of the 335 negative lines.
//
// The unknown-line counts ride along because they change what the row means: a
// product with unquantified acquisitions is data-entry debt (the missing count
// is probably the explanation), while one with a fully quantified ledger is a
// genuine contradiction.
export const negativeExpectedQuantitySchema = z.object({
  ...productProblemFields,
  /** Negative by construction — that is the defect. */
  expectedQuantity: z.number().int(),
  acquiredUnits: z.number().int(),
  exitedUnits: z.number().int(),
  unknownAcquisitionLines: z.number().int(),
  unknownExitLines: z.number().int(),
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
  // counts as one, matching how the ledger reads a bare sale row. Always a
  // POSITIVE unit count: `productQuantity` is signed, and a negative-cost line
  // is read as `−|qty|`, so the detector takes `abs()` and either stored sign
  // yields the same number here.
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

// The exact inverse of `soldButStillStocked`: a disposal line that names no
// product at all.
//
// That detector can only fire when the sale is linked, so an exit whose
// `productId` is null is invisible to it BY CONSTRUCTION — and those are the
// common case for marketplace sales, where rows arrive from a statement or an
// export with a payout description and nothing tying them to a shelf. Both of
// the finds that motivated this were exactly that shape, and neither showed up
// anywhere.
//
// Keyed on a disposal Purchase for the same reason its mirror is, and the
// reasoning is worth not restating: see `soldButStillStockedSchema` above and
// the essay over `findSoldButStillStocked`. Negative Expense lines on their own
// are overwhelmingly refunds, price adjustments, and family contributions —
// every one of them legitimate, none of them a sale.
export const unlinkedExitExpenseSchema = z.object({
  id: expenseShortcode,
  name: z.string(),
  /** Negative, as stored. */
  cost: z.number(),
  date: plainDate.nullable(),
  /** The disposal Purchase this line sits on. */
  purchaseId: purchaseShortcode,
  /** Through the join; null only if the vendor was soft-deleted. */
  vendorName: z.string().nullable(),
});

// The blind spot in `unlinkedExitExpenseSchema` above, which keys on a disposal
// Purchase and therefore cannot see a row that has no Purchase at all — an
// `innerJoin` drops it before the predicate ever runs.
//
// Deliberately NOT folded into that detector. A purchase-less negative line is
// about half sales (an item handed over for cash, entered by hand) and half
// money that never bought anything (family contributions, a neighbour's share
// of a shared cost). Neither the ledger nor the settlement side carries a
// signal separating them, so this is reported as `coverage` — a worklist, never
// a red count. Widening the disposal-Purchase predicate instead would import
// that same ambiguity into a detector that is currently precise.
export const purchaselessExitExpenseSchema = z.object({
  id: expenseShortcode,
  name: z.string(),
  /** Negative, as stored. */
  cost: z.number(),
  date: plainDate.nullable(),
  /** Present on most rows; the closest thing to a hint about what this was. */
  projectName: z.string().nullable(),
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
 * A stored file no edge still reaches — R2 bytes nothing can render.
 *
 * Permanent diagnostic exceptions, same reasoning as
 * {@link orphanedEntityEmbeddingSchema}: `Image` has no public shortcode at all,
 * and `targetType`/`targetId` are provenance recorded at attach time, so the
 * entity they name may itself be gone. They are shown to say where the file came
 * from, never to link anywhere.
 */
export const unreferencedImageSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  createdAt: z.date(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
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

// A meal planned to be COOKED but carrying no live planned recipe — the
// half-finished state: you put it on the calendar and never chose what to make.
// Deliberately scoped to `cooked`: a recipe-less `eating_out`/`takeout` meal is
// a complete record, not a gap, and flagging one would make the detector argue
// with the meal's own stated intent. Counts a recipe as gone when either the
// link or the recipe itself is soft-deleted, matching what `dbMealToAPI`
// renders — a meal whose only recipe was deleted looks empty on the page, so
// the detector has to agree or it reports a population the UI can't show.
export const emptyCookedMealSchema = z.object({
  id: mealShortcode,
  name: z.string().nullable(),
  date: plainDate,
});

// A planned meal whose cost rollup is knowingly incomplete: at least one of
// its live recipes was costed and came back with fewer priced ingredients than
// it has (`costCovered < ingredientCount`).
//
// Deliberately NOT `totals IS NULL`. That set is "the costing queue hasn't run
// yet", it drains itself the moment the client opens, and `staleRecipeTotals`
// already reports it in the maintenance card with a Fix button. This one does
// not self-heal: the meal's cost stays understated until an ingredient gets a
// price path, and `recipe-totals-gaps.ts` already ranks those fixes.
export const understatedCostMealSchema = z.object({
  id: mealShortcode,
  name: z.string().nullable(),
  date: plainDate,
  /** Live planned recipes carrying at least one unpriced ingredient. */
  recipeCount: z.number().int(),
});

// A live recipe with no instruction text anywhere — every live section's
// `instructions` array is empty.
//
// Book- and Notion-sourced recipes are excluded, not flagged: a cookbook import
// legitimately carries no instructions because the instructions are in the book
// on the shelf. Including them would bury the recipes that are actually
// half-entered under the ones that are working as designed — the same reason
// the trigram index at schema.ts excludes those two sources.
export const recipeWithoutInstructionsSchema = z.object({
  id: recipeShortcode,
  name: z.string(),
  sectionCount: z.number().int(),
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
  /** Derived link out to the vendor's own order page; null if not linkable. */
  orderUrl: z.url().nullable(),
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

/**
 * An unlinked Expense that looks like the same money as an already-itemized
 * Purchase — the hand-entered lump that a later vendor import duplicated.
 *
 * **Advisory, not a defect.** The 2026-07/08 imports minted itemized purchases
 * for orders already booked as single 2024 lump rows; neither side knew about
 * the other, so seven orders were counted twice ($296.61). Nothing detected it.
 *
 * The row is keyed on the **Expense**, because that is what a human acts on: the
 * fix is to carry its project/trade onto the purchase's lines, preserve its name
 * in the purchase's `displayLabel`, then delete it. Never auto-applied — a
 * same-amount coincidence is real (a $22.00 "fiskars pruners" row collided with
 * an unrelated $22.00 Amazon order), so this reports and a human decides.
 *
 * `matchedOn` distinguishes the two arms. `stated_total` is not redundant with
 * `expense_total`: three of the seven real duplicates matched only the stated
 * total, because the import had left those purchases under-itemized (missing tax
 * or a line the vendor CSV never exported) — which made them the worst
 * double-counts, not the weakest signals.
 */
export const duplicateSpendCandidateSchema = z.object({
  /** The unlinked Expense — the row to act on. */
  id: expenseShortcode,
  expenseName: z.string(),
  cost: z.number(),
  expenseDate: plainDate.nullable(),
  /** The itemized purchase that appears to already cover this money. */
  purchaseId: purchaseShortcode,
  /** Through the join; null only if the vendor was soft-deleted. */
  vendorName: z.string().nullable(),
  purchaseDate: plainDate.nullable(),
  /** `SUM(cost)` over the purchase's live expenses. */
  purchaseExpenseTotal: z.number(),
  /** What the paperwork claimed. Never spend. Null if none recorded. */
  purchaseStatedTotal: z.number().nullable(),
  purchaseExpenseCount: z.number().int(),
  /** Which total the expense's cost equalled. */
  matchedOn: z.enum(["expense_total", "stated_total"]),
  dayDelta: z.number().int(),
  /** Trigram score against the purchase's line and product names, 0–1. */
  nameSimilarity: z.number(),
  /** Other purchases this expense also matched, all scoring lower. */
  alternateMatchCount: z.number().int(),
});

/**
 * Trigram floor for calling an unlinked Expense a duplicate of a Purchase.
 *
 * Calibrated against every duplicate ever resolved in this ledger — 22 rows that
 * a human deleted as duplicates, replayed through the detector. 21 of them score
 * **0.217–1.000**; the live same-amount coincidence that must NOT fire scores
 * 0.095, and matching the *wrong* one of two purchases sharing a price scores
 * 0.000. Any floor in (0.107, 0.217] yields 21/22 recall at 100% precision.
 *
 * The 22nd — "blum hardware test" against twelve SKU-described Blum parts — scores
 * 0.107 and is a deliberate miss. Its hand-entered name carries only a brand that
 * appears in none of the vendor's line names, so the signal genuinely is not there;
 * catching it would mean a floor of 0.10, which sits *below* the 0.088 median of
 * random pairs and would stop discriminating at all. A lump named only for a brand
 * the vendor doesn't print is the known false-negative class.
 *
 * This is a **secondary** gate and is worthless on its own — across all 127,686
 * orphan x purchase pairs the score has mean 0.10 and p95 0.25, so a fifth of
 * random pairs clear it. It only discriminates once amount + date has pruned the
 * field to a handful. Keep it applied after that join, never before.
 */
export const DUPLICATE_SPEND_NAME_SIMILARITY = 0.15;

/** Days either side of a purchase's date an unlinked expense may sit and still pair. */
export const DUPLICATE_SPEND_DAY_WINDOW = 7;

export const duplicateFinancialTransactionSourceRefSchema = z.object({
  source: z.string(),
  externalId: z.string(),
  transactionIds: z.array(financialTransactionShortcode),
});

/**
 * A provider export whose stored rows fall short of the count the client
 * declared — a chunked ingest that stopped partway.
 *
 * This is deliberately the ONLY statement-ledger detector. "Every unmatched row"
 * is not a defect list: it is the drift worklist, 15k rows at its widest, and
 * putting it here would make `list_problems` unusable. Unmatched rows are read
 * through `list_statement_rows({matchState:"unmatched"})` instead.
 */
export const incompleteStatementImportSchema = z.object({
  source: z.string(),
  label: z.string(),
  fingerprint: z.string(),
  rowCountDeclared: z.number().int(),
  rowCountStored: z.number().int(),
});

export const duplicateFinancialAccountSourceAliasSchema = z.object({
  source: z.string(),
  externalAccountId: z.string(),
  accountIds: z.array(financialAccountShortcode),
});

/**
 * A broken `FinancialTransactionAllocation` invariant. Every reason has a
 * mechanical cause and a definite right answer, so this is a `defect`, not a
 * judgment call like `purchaseFinancialSettlementMismatches`.
 */
export const financialTransactionAllocationDefectReason = z.enum([
  /** Allocations exist but do not sum to the transaction's own amount. */
  "sum-mismatch",
  /** A transaction of a non-settlement kind carries allocations. */
  "non-settlement-kind",
  /** The transaction's amount has the wrong sign for its kind. Replaces the DB CHECK, which passes vacuously once the mirror is NULL. */
  "kind-sign-violation",
  /** An allocation's sign differs from the transaction it slices. */
  "allocation-sign-mismatch",
]);

export const financialTransactionAllocationDefectSchema = z.object({
  id: financialTransactionShortcode,
  reasons: z.array(financialTransactionAllocationDefectReason).min(1),
  kind: z.string(),
  amount: z.number(),
  allocationCount: z.number().int(),
  allocatedTotal: z.number(),
  purchaseIds: z.array(purchaseShortcode),
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
  unlinkedExitExpenses: z.array(unlinkedExitExpenseSchema),
  purchaselessExitExpenses: z.array(purchaselessExitExpenseSchema),
  negativeExpectedQuantity: z.array(negativeExpectedQuantitySchema),
  toolsUsedOutsideOwnership: z.array(toolUsedOutsideOwnershipSchema),
  productsWithoutMappings: z.array(productWithoutMappingsSchema),
  ingredientsWithoutProduct: z.array(ingredientWithoutProductSchema),
  productsWithNoImages: z.array(productWithNoImagesSchema),
  orphanedEntityEmbeddings: z.array(orphanedEntityEmbeddingSchema),
  unreferencedImages: z.array(unreferencedImageSchema),
  entitiesMissingEmbeddings: z.array(entityMissingEmbeddingSchema),
  staleParentRecipes: z.array(staleParentRecipeSchema),
  emptyCookedMeals: z.array(emptyCookedMealSchema),
  understatedCostMeals: z.array(understatedCostMealSchema),
  recipesWithoutInstructions: z.array(recipeWithoutInstructionsSchema),
  staleLocations: z.array(staleLocationSchema),
  unknownParkedItems: z.array(unknownParkedItemSchema),
  manufacturerSpellingVariants: z.array(labelVariantSchema),
  duplicateVendors: z.array(duplicateVendorSchema),
  vendorsWithoutLogos: z.array(vendorWithoutLogoSchema),
  purchasesNotReconciling: z.array(purchaseNotReconcilingSchema),
  purchaseFinancialSettlementMismatches: z.array(
    purchaseFinancialSettlementMismatchSchema,
  ),
  duplicateSpendCandidates: z.array(duplicateSpendCandidateSchema),
  duplicateFinancialTransactionSourceRefs: z.array(
    duplicateFinancialTransactionSourceRefSchema,
  ),
  duplicateFinancialAccountSourceAliases: z.array(
    duplicateFinancialAccountSourceAliasSchema,
  ),
  financialTransactionAllocationDefects: z.array(
    financialTransactionAllocationDefectSchema,
  ),
  invalidFinancialJson: z.array(invalidFinancialJsonSchema),
  // A live row still pointing at a soft-deleted target — see
  // `findReferentialLivenessViolations`. DB-only and cheap (one UNION ALL over
  // 34 indexed FK joins), so it belongs in `fast` rather than earning its own
  // cost group: the expense is I/O, not the CPU the other groups isolate.
  referentialLivenessViolations: z.array(referentialLivenessViolationSchema),
  incompleteStatementImports: z.array(incompleteStatementImportSchema),
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
/**
 * True population size for any section whose rows are a SAMPLE rather than the
 * whole set — keyed by `ProblemKey`, absent for a section that returns
 * everything.
 *
 * A view-backed section renders page 1 of the entity's list, so `items.length`
 * is the page size, not the answer. Every count downstream (the badge, the
 * homepage banner, `totalProblems`, and the coverage meters' "N of M") has to
 * read the total instead, or a 212-row backlog reports as 12.
 *
 * It's a sibling map rather than a richer per-section value on purpose:
 * `allProblemArrayFields` must stay arrays-only, because `byTypeShape`,
 * `EMPTY_PROBLEM_ARRAYS`, and `countProblems` are all mechanically derived from
 * its keys and would break on a non-array member.
 */
export const sectionTotalsSchema = z.record(z.string(), z.number().int());
export type SectionTotals = z.infer<typeof sectionTotalsSchema>;

/**
 * Sections backed by a saved view rather than a bespoke detector.
 *
 * The rows come from the entity's ordinary list procedure. Each key keeps the
 * row schema it already had, because the list-item shape is a strict SUPERSET
 * of it — `inventoryListItemOut` carries the `id`, `amount`, `createdAt`,
 * `product` and `location` that `neverVerifiedInventorySchema` declares, plus
 * `valuation`, `verifiedAt` and `placement` it doesn't — so the service narrows
 * rather than the card widening.
 *
 * Keeping the narrow schema is also what avoids an import cycle: `inventory.ts`
 * and `product.ts` both import FROM this module, so referencing their list
 * shapes here would make module init order load-bearing. If a card ever needs a
 * field only the list row has, widen that one schema; don't reach for the list
 * shape.
 *
 * These rows are a PAGE, not the population — see `sectionTotals`.
 */
const problemsViewsShape = {
  neverVerifiedInventory: z.array(neverVerifiedInventorySchema),
  locationsWithoutAiDescription: z.array(locationWithoutAiDescriptionSchema),
  emptyLocations: z.array(emptyLocationSchema),
  unusedIngredientsWithProduct: z.array(unusedIngredientSchema),
  unusedIngredientsWithoutProduct: z.array(unusedIngredientSchema),
};

export const problemsViewsSchema = z.object({
  ...problemsViewsShape,
  /** True population per key; the page above is only what the card shows. */
  sectionTotals: sectionTotalsSchema,
});
export type ProblemsViewsOut = z.infer<typeof problemsViewsSchema>;

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
  ...problemsViewsShape,
};

export const allProblemsSchema = z.object({
  ...allProblemArrayFields,
  sectionTotals: sectionTotalsSchema.default({}),
  totalProblems: z.number(),
});

/** Stable empty totals — shared identity, for the same memo-churn reason as
 *  {@link EMPTY_PROBLEM_ARRAYS}. */
export const EMPTY_SECTION_TOTALS: SectionTotals = Object.freeze({});

/**
 * How many rows a section really covers: its declared total when it reports a
 * sample, else the rows it returned. The single definition, so a caller can't
 * accidentally count a page.
 */
export const sectionSize = (
  /** Absent for a section that returns its whole population. */
  key: string | undefined,
  items: readonly unknown[],
  totals: SectionTotals | undefined,
): number => (key ? (totals?.[key] ?? items.length) : items.length);

export type ProblemKey = keyof typeof allProblemArrayFields;

/** The detector sections of `AllProblems`, without the derived `totalProblems`. */
export type ProblemArrays = { [K in ProblemKey]: AllProblems[K] };

/**
 * Every detector key at empty. The Problems page merges four separately-loaded
 * cost groups into one `AllProblems`, and a group that hasn't resolved yet has
 * to render as empty sections rather than as missing keys — spreading the
 * loaded groups over this derives all 42 defaults from the group shapes, so a
 * new detector needs no edit at the merge site.
 *
 * The empty arrays are shared rather than rebuilt per merge: problem sections
 * are only ever read, and a stable identity keeps a not-yet-loaded group from
 * churning the memos downstream of the merge on every recompute.
 */
export const EMPTY_PROBLEM_ARRAYS: ProblemArrays = Object.freeze(
  Object.keys(allProblemArrayFields).reduce((empty, key) => {
    empty[key as ProblemKey] = [];
    return empty;
  }, {} as ProblemArrays),
);

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
  // Every row is a sale whose product was never identified, so the ledger
  // cannot say what left. Converges: each row is either linked to a product or
  // recorded as an exception. No auto-fix — deciding WHICH product a marketplace
  // payout describes is the whole of the work, and guessing it would write a
  // false ownership history that `soldButStillStocked` would then trust.
  unlinkedExitExpenses: "defect",
  // `coverage`, NOT `defect`, and the distinction is the whole point of the
  // detector existing separately from `unlinkedExitExpenses` above.
  //
  // That one is a defect because every row it reports is genuinely a sale
  // missing its product. This one reports negative lines with no Purchase, and
  // roughly half of those are legitimately productless — a family
  // contribution, a neighbour's share of a shared cost. There is no signal
  // separating those from a hand-entered cash sale, so a red count here would
  // be permanently non-zero and would train the reader to ignore it. Advisory
  // means it can carry that ambiguity honestly. No auto-fix for the same
  // reason.
  purchaselessExitExpenses: "coverage",
  // A contradiction, not a shortfall: more units left than ever arrived, so
  // some row is wrong and fixing it removes the product from the list for
  // good. `coverage` would be wrong — there is no denominator, and no reported
  // row is legitimately correct as it stands. No auto-fix: the repair is
  // whichever line is missing or miscounted, which only a human can decide.
  negativeExpectedQuantity: "defect",
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
  // Every row is a removal path that dropped an association without taking the
  // file with it. Converges to zero once each such path is fixed, so a row here
  // names a bug rather than a backlog.
  unreferencedImages: "defect",
  entitiesMissingEmbeddings: "defect",
  staleParentRecipes: "defect",
  // A cooked meal with nothing planned is unfinished, and it converges to zero
  // two ways: plan a recipe, or re-kind it to what it actually was. Not
  // `coverage` — there is no denominator and no backlog being worked through,
  // just a row that is either finished or mislabelled. No auto-fix: only the
  // cook knows which of the two resolutions is true.
  emptyCookedMeals: "defect",
  // The number on the meal is wrong, not merely unfinished, and it stays wrong
  // until someone gives an ingredient a price path. Converges to zero; no
  // auto-fix, because the fix is a pricing decision.
  understatedCostMeals: "defect",
  // A recipe you can't cook from. Converges to zero once typed in, and the
  // book/Notion sources that legitimately have none are excluded rather than
  // tolerated, so a row here is always real work.
  recipesWithoutInstructions: "defect",
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
  // Advisory for a different reason than the two above: the match itself is a
  // heuristic. Amount + date is what finds these at all, and two unrelated things
  // legitimately cost the same on the same day, so a row here is a cue to look
  // rather than a fault. It is also the one detector whose "fix" destroys data
  // (delete the duplicate), which must never be mechanical or red.
  duplicateSpendCandidates: "coverage",
  duplicateFinancialTransactionSourceRefs: "defect",
  duplicateFinancialAccountSourceAliases: "defect",
  financialTransactionAllocationDefects: "defect",
  invalidFinancialJson: "defect",
  incompleteStatementImports: "defect",
} as const satisfies Record<ProblemKey, ProblemClass>;

export type ProblemClass = "defect" | "coverage";

/**
 * The keys classed `coverage`. Derived, so the Problems page can require that a
 * section marked coverage names the keys it renders and that every key classed
 * here has such a section — the two declarations agreed by hand before this,
 * with nothing to catch a new coverage detector rendered in the defect list.
 */
export type CoverageProblemKey = {
  [K in ProblemKey]: (typeof PROBLEM_CLASS)[K] extends "coverage" ? K : never;
}[ProblemKey];

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
  totals?: SectionTotals,
): number =>
  Object.entries(sections).reduce(
    (n, [key, items]) =>
      isDefectKey(key) === (problemClass === "defect")
        ? n + sectionSize(key, items, totals)
        : n,
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
  // `sectionTotals` must come OUT of the rest — it is not a detector section,
  // and leaving it in would put a non-array into `byType`.
  const { totalProblems, sectionTotals, ...arrays } = all;
  const byType = Object.fromEntries(
    Object.entries(arrays).map(([key, items]) => [
      key,
      sectionSize(key, items, sectionTotals),
    ]),
  ) as ProblemsCount["byType"];
  // `byType` stays the FULL roster (coverage keys included) so per-detector
  // consumers and the MCP `type` slices keep working; only the totals split.
  return {
    total: totalProblems,
    coverageTotal: sumProblemSections(arrays, "coverage", sectionTotals),
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
  /** View-backed sections: sampled rows plus the totals that describe them.
   *  Required, so a caller can't silently drop a converted section. */
  views: ProblemsViewsOut;
}): AllProblems => {
  const { sectionTotals, ...viewSections } = groups.views;
  const sections = {
    ...groups.fast,
    ...groups.coverage,
    ...groups.upc,
    ...groups.tracker,
    ...viewSections,
  };
  return {
    ...sections,
    sectionTotals,
    // Counts the true population of a sampled section, not its page.
    totalProblems: sumProblemSections(sections, "defect", sectionTotals),
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
export type UnlinkedExitExpense = z.infer<typeof unlinkedExitExpenseSchema>;
export type PurchaselessExitExpense = z.infer<
  typeof purchaselessExitExpenseSchema
>;
export type NegativeExpectedQuantity = z.infer<
  typeof negativeExpectedQuantitySchema
>;
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
export type EmptyCookedMeal = z.infer<typeof emptyCookedMealSchema>;
export type UnderstatedCostMeal = z.infer<typeof understatedCostMealSchema>;
export type RecipeWithoutInstructions = z.infer<
  typeof recipeWithoutInstructionsSchema
>;
export type ProductWithBetterUpcData = z.infer<
  typeof productWithBetterUpcDataSchema
>;
export type PurchaseNotReconciling = z.infer<
  typeof purchaseNotReconcilingSchema
>;
export type PurchaseFinancialSettlementMismatch = z.infer<
  typeof purchaseFinancialSettlementMismatchSchema
>;
export type DuplicateSpendCandidate = z.infer<
  typeof duplicateSpendCandidateSchema
>;
export type DuplicateFinancialTransactionSourceRef = z.infer<
  typeof duplicateFinancialTransactionSourceRefSchema
>;
export type DuplicateFinancialAccountSourceAlias = z.infer<
  typeof duplicateFinancialAccountSourceAliasSchema
>;
export type FinancialTransactionAllocationDefect = z.infer<
  typeof financialTransactionAllocationDefectSchema
>;
export type InvalidFinancialJson = z.infer<typeof invalidFinancialJsonSchema>;
export type IncompleteStatementImport = z.infer<
  typeof incompleteStatementImportSchema
>;
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
  // UPLOADED files no edge reaches — what the "Delete unreferenced files" tool
  // clears. The same figure the matching Problems section lists (it is uncapped).
  unreferencedImages: z.number().int(),
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

export const deleteUnusedIngredientsInput = z
  .object({
    /** Explicit rows — what a per-card "Delete" acts on. */
    ingredientIds: z.array(ingredientShortcode).optional(),
    /**
     * Act on every row the named view-backed section selects, resolved
     * SERVER-side.
     *
     * A view-backed card renders a page, so a "Delete all" wired to the rows it
     * was handed would delete the page and call it all. Naming the section and
     * letting the server re-run its filters is what keeps the label true —
     * membership belongs on the server, not in the component that happened to
     * render twelve of them.
     */
    allFromProblem: z
      .enum(["unusedIngredientsWithProduct", "unusedIngredientsWithoutProduct"])
      .optional(),
    alsoDeleteProducts: z.boolean(),
  })
  .refine(
    (input) =>
      (input.ingredientIds === undefined) !==
      (input.allFromProblem === undefined),
    { message: "Provide exactly one of ingredientIds or allFromProblem" },
  );

export const deleteUnusedIngredientsOut = z.object({
  deleted: z.number(),
  failed: z.array(z.object({ id: ingredientShortcode, reason: z.string() })),
});
