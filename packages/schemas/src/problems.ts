import { z } from "zod";
import { amount, baseKind } from "./codec";
import { money, moneyNullable } from "./money";
import { shortcodeEntities, type ShortcodeEntity } from "./entity-manifest";
import { referentialLivenessViolationSchema } from "./entity-integrity";
import { financialReconciliationFields } from "./financial-reconciliation";
import {
  anyShortcodeSchema,
  cookbookShortcode,
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  imageShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  taskShortcode,
  vendorShortcode,
  nonEmptyTuple,
} from "./identifiers";
import { imageProcessingIssue } from "./image";
import {
  plainDate,
  type ProjectAttentionType,
  projectAttentionItemSchema,
} from "./project";
import { searchableEntityRefFields } from "./search";
import { proposedImportFix } from "./purchase-import";

const publicEntityIdSchema = anyShortcodeSchema(
  nonEmptyTuple<ShortcodeEntity>(shortcodeEntities),
);

export { baseKind, type BaseKind } from "./codec";

const productProblemFields = {
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
};
const coverageFields = {
  covered: z.array(baseKind),
  applicable: z.array(baseKind),
};

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

export const partiallyImportedCookbookSchema = z.object({
  id: cookbookShortcode,
  name: z.string(),
  sourceRecipeCount: z.number().int().nonnegative(),
  recipeCount: z.number().int().nonnegative(),
  missingRecipeCount: z.number().int().positive(),
});
export type PartiallyImportedCookbook = z.infer<
  typeof partiallyImportedCookbookSchema
>;

/** An uploaded image with a durable current-processing finding. */
export const imageProcessingProblemSchema = z.object({
  id: imageShortcode,
  filename: z.string(),
  processingIssue: imageProcessingIssue,
});
export type ImageProcessingProblem = z.infer<
  typeof imageProcessingProblemSchema
>;

// A product that is stocked but carries no `price`, so its inventory entries
// value at nothing and the location rollup silently under-reports. Split into
// two sections rather than one: a `misc:` bucket is a heterogeneous pile with no
// meaningful unit price, so flagging it alongside real products would keep the
// section permanently red. Mirrors the miscNoPrice/missingPricing split the
// per-location valuation summary already makes.
export const productMissingPriceSchema = z.object({
  ...productProblemFields,
  inventoryQuantity: z.number(),
  locations: z.array(
    z.object({
      id: locationShortcode,
      name: z.string(),
    }),
  ),
});

/**
 * A product sold by weight whose expense lines nonetheless claim a fixed
 * quantity, so `derivedPrice` averages line totals for items that each weighed
 * something different. The average is not a unit price, and a gram-denominated
 * recipe line reading through it gets no money path at all — it drops out of
 * `costCovered` silently rather than erroring.
 *
 * Distinct from `productsWithoutMappings`, which needs the pack size in the
 * product NAME (a weight-sold item never carries one — the line reads
 * "1 Each"), and from `productMissingPrice`, which these products pass: they
 * look priced, which is exactly why the gap is invisible.
 *
 * The signature is a repeat-purchase one, so it needs history to fire:
 * `distinctPriceFraction` separates weight-sold goods (nearly every purchase a
 * different amount) from packaged goods whose price merely drifted across sales
 * and years (a handful of prices repeated many times). Measured on this
 * household's ledger, weight-sold produce and meat sit at 0.80-0.97 while
 * per-each and packaged goods sit at 0.19-0.32.
 *
 * The fix is a weight-to-money unit mapping; `price` is the wrong shape here
 * and setting it papers over the gap.
 */
export const weightSoldProductSchema = z.object({
  ...productProblemFields,
  /** Priced principal expense lines behind the verdict. */
  lineCount: z.number().int().positive(),
  /** Distinct unit costs ÷ `lineCount`. Near 1 means priced by weight. */
  distinctPriceFraction: z.number(),
  lowUnitCost: money,
  highUnitCost: money,
  /** Non-null means a recipe can already read through it and mis-cost. */
  ingredientId: ingredientShortcode.nullable(),
});
export type WeightSoldProduct = z.infer<typeof weightSoldProductSchema>;

export const negativeExpectedQuantitySchema = z.object({
  ...productProblemFields,
  expectedQuantity: z.number(),
  acquiredUnits: z.number(),
  exitedUnits: z.number(),
  unknownAcquisitionLines: z.number().int(),
  unknownExitLines: z.number().int(),
});

export const soldButStillStockedSchema = z.object({
  ...productProblemFields,
  // Units accounted for by disposal lines. A line with no `productQuantity`
  // counts as one, matching how the ledger reads a bare sale row. Always a
  // POSITIVE unit count: `productQuantity` is signed, and a negative-cost line
  // is read as `−|qty|`, so the detector takes `abs()` and either stored sign
  // yields the same number here.
  soldQuantity: z.number(),
  // Units still owned according to the shared on-hand projection. Mixed-unit
  // stock has no honest number and is not reported.
  liveQuantity: z.number(),
  proceeds: z.number(),
  locations: z.array(
    z.object({
      id: locationShortcode,
      name: z.string(),
    }),
  ),
});

export const kitCountedTwiceSchema = z.object({
  ...productProblemFields,
  ownUnits: z.number(),
  /**
   * Units the LEDGER says were acquired and not disposed of.
   *
   * Deliberately not named `expectedQuantity`: that is a manual column on
   * `Product` ("this should appear exactly once"), and reading it here returns
   * null on every kit. This is the derived `quantityLedger.expectedQuantity`.
   */
  expectedUnits: z.number().int(),
});

export const unlinkedExitExpenseSchema = z.object({
  id: expenseShortcode,
  name: z.string(),
  cost: money,
  date: plainDate.nullable(),
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
// money that never bought anything (for example, a neighbour's share of a
// shared cost). Neither the expense nor settlement side carries a
// signal separating them, so this is reported as `coverage` — a worklist, never
// a red count. Widening the disposal-Purchase predicate instead would import
// that same ambiguity into a detector that is currently precise.
export const purchaselessExitExpenseSchema = z.object({
  id: expenseShortcode,
  name: z.string(),
  cost: money,
  date: plainDate.nullable(),
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
  toolDate: plainDate,
  projectBoundary: plainDate,
});

export const duplicateProductIdentitySchema = z.object({
  manufacturer: z.string(),
  model: z.string(),
  products: z.array(
    z.object({
      id: productShortcode,
      name: z.string(),
      gtins: z.array(z.string()),
      sources: z.array(z.string()),
    }),
  ),
});

export const productWithoutMappingsSchema = z.object({
  ...productProblemFields,
  createdAt: z.date(),
  isIngredient: z.boolean(),
  usdaUnavailable: z.boolean(),
  ingredientId: ingredientShortcode.nullable(),
});

/**
 * A product whose own NAME states a pack size it has no unit mapping for —
 * "Bagged Yellow Onions, 32 OZ" with no `1 each = 32 oz` edge, so it can show
 * no comparable unit price.
 *
 * `proposed` is the parsed amount, pre-computed server-side by the Rust
 * grammar, and `token` is the exact substring it came from so the card can show
 * its own evidence rather than asking the reader to trust it. Accepting is a
 * human act: titles that carry a pack count are refused upstream precisely
 * because they parse to a per-each size 6-12x too small.
 */
export const productWithTitleDerivableSizeSchema = z.object({
  ...productProblemFields,
  category: z.string().nullable(),
  // `amount` — the Rust title grammar that produces `proposed` always parses
  // a real unit token (that's the substring `token` echoes), so the added
  // `unit.min(1)` can't reject it.
  proposed: amount,
  token: z.string(),
});

export const ingredientWithPartialCoverageSchema = z.object({
  ...productProblemFields,
  coverage: z.object(coverageFields),
  hasPrice: z.boolean(),
  hasUsdaLink: z.boolean(),
  usdaUnavailable: z.boolean(),
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

export const unusedIngredientSchema = z.object({
  id: ingredientShortcode,
  name: z.string(),
  createdAt: z.date(),
  products: z.array(z.object({ id: productShortcode, name: z.string() })),
});

export const emptyLocationSchema = z.object({
  id: locationShortcode,
  name: z.string(),
  type: z.string().nullable(),
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
  type: z.string().nullable(),
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
  location: z.object({
    id: locationShortcode,
    name: z.string(),
  }),
});

/**
 * A live inventory entry whose Product HAS an effective price, yet whose
 * `valuation` is null — the amount's unit has no path to money through that
 * Product's unit-mapping graph.
 *
 * The actionable distinction the location rollup's `missingPricing` bucket
 * loses: "set a price" and "add a conversion edge" are different fixes, and
 * only the second one is this.
 */
export const inventoryWithoutPricePathSchema = z.object({
  id: inventoryShortcode,
  amount,
  effectivePrice: money,
  product: z.object({
    id: productShortcode,
    name: z.string(),
  }),
  location: z.object({
    id: locationShortcode,
    name: z.string(),
  }),
});

const labelVariantFields = {
  value: z.string(),
  /**
   * How much backs this spelling: products carrying it for a manufacturer, live
   * purchases pointing at it for a vendor (whose name is unique per row, so
   * counting rows there could never produce a majority).
   */
  count: z.number().int(),
  canonical: z.string(),
  canonicalCount: z.number().int(),
};

export const labelVariantSchema = z.object({
  ...labelVariantFields,
  sampleId: productShortcode,
});

export const duplicateVendorSchema = z.object({
  ...labelVariantFields,
  sampleId: vendorShortcode,
  canonicalSampleId: vendorShortcode,
});

export const vendorWithoutLogoSchema = z.object({
  id: vendorShortcode,
  name: z.string(),
  website: z.string().nullable(),
  purchaseCount: z.number().int(),
  expenseRowCount: z.number().int(),
});

export const productWithNoImagesSchema = z.object({
  ...productProblemFields,
  primaryGtin: z.string().nullable(),
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
  type: z.string().nullable(),
  imageCount: z.number(),
});

/**
 * A live entity with no embedding row under the current provider/model/dimensions
 * — invisible to semantic search until backfilled. Carries no id/model of its
 * own because there is no row yet.
 *
 * These rows are a SAMPLE (the detector caps them); `MaintenanceCounts.
 * entitiesMissingEmbeddings` carries the true figure.
 */
export const entityMissingEmbeddingSchema = z.object({
  ...searchableEntityRefFields,
  // Deliberately NOT hoisted onto `searchableEntityRefFields` itself: this row
  // always points at a LIVE entity, so it can always be resolved and is safe
  // to link. Plain string, not a branded schema: `entityType` is one of ten
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

// A planned meal whose cost rollup is knowingly incomplete: at least one of
// its live recipes was costed and came back with fewer priced ingredients than
// it has (`costCovered < ingredientCount`), including none — an `unavailable`
// cost whose `coverage` records 0 of N. Legacy `unavailable` rows without
// `coverage` are not reported until recomputed.
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
  recipeCount: z.number().int(),
  affectedRecipes: z.array(
    z.object({
      id: recipeShortcode,
      name: z.string(),
      costCovered: z.number().int().nonnegative(),
      ingredientCount: z.number().int().nonnegative(),
    }),
  ),
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
    price: moneyNullable, // dollars, matches product.price + lookup.priceDollars
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
  orderUrl: z.url().nullable(),
  date: plainDate.nullable(),
  /** What the paperwork claimed. Never spend. */
  statedTotal: money,
  /** `SUM(cost)` over the purchase's live expenses — its real spend. */
  expenseTotal: money,
  expenseCount: z.number().int(),
  unpricedExpenseCount: z.number().int(),
  /**
   * Posted refund evidence used to distinguish explained differences. Taken
   * from the canonical field map rather than hand-restated, so it keeps that
   * schema's `.finite()` guard.
   */
  postedRefundTotal: financialReconciliationFields.postedRefundTotal,
});

export const purchaseFinancialSettlementMismatchSchema = z.object({
  id: purchaseShortcode,
  vendorName: z.string().nullable(),
  expenseTotal: money,
  // Spreads the canonical field map rather than hand-restating it, so the
  // `.finite()` guards cannot be dropped again. Two fields genuinely narrow
  // here, because this detector only ever emits the "mismatch" case: `delta`
  // is null exactly when the summary is not comparable, and that is exactly
  // when `status` is "unknown" (see `calculateFinancialReconciliation`) — so a
  // mismatch always carries a delta, and callers should not have to handle a
  // null that cannot occur.
  financialReconciliation: z.object({
    status: z.literal("mismatch"),
    ...financialReconciliationFields,
    delta: money.finite(),
  }),
});

export const duplicateSpendCandidateSchema = z.object({
  id: expenseShortcode,
  expenseName: z.string(),
  cost: money,
  expenseDate: plainDate.nullable(),
  purchaseId: purchaseShortcode,
  /** Through the join; null only if the vendor was soft-deleted. */
  vendorName: z.string().nullable(),
  purchaseDate: plainDate.nullable(),
  /** `SUM(cost)` over the purchase's live expenses. */
  purchaseExpenseTotal: money,
  /** What the paperwork claimed. Never spend. Null if none recorded. */
  purchaseStatedTotal: moneyNullable,
  purchaseExpenseCount: z.number().int(),
  matchedOn: z.enum(["expense_total", "stated_total"]),
  dayDelta: z.number().int(),
  nameSimilarity: z.number(),
  alternateMatchCount: z.number().int(),
});

export const DUPLICATE_SPEND_NAME_SIMILARITY = 0.15;

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
  "non-settlement-kind",
  /** The transaction's amount has the wrong sign for its kind. Replaces the DB CHECK, which passes vacuously once the mirror is NULL. */
  "kind-sign-violation",
  "allocation-sign-mismatch",
]);

export const financialTransactionAllocationDefectSchema = z.object({
  id: financialTransactionShortcode,
  /**
   * How the transaction identifies itself to a person — merchant, else its raw
   * bank descriptor. Null only when the row carries neither, which is why the
   * card falls back to the shortcode rather than assuming a name exists.
   */
  name: z.string().nullable(),
  postedDate: plainDate.nullable(),
  reasons: z.array(financialTransactionAllocationDefectReason).min(1),
  kind: z.string(),
  amount: money,
  allocationCount: z.number().int(),
  allocatedTotal: money,
  purchaseIds: z.array(purchaseShortcode),
});

export const invalidFinancialJsonSchema = z.discriminatedUnion("entity", [
  z.object({
    entity: z.literal("financialAccount"),
    id: financialAccountShortcode,
    field: z.enum(["identity", "sourceAliases", "cardNumbers"]),
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
// chunks (one Start operation each, so every group runs in
// its own Worker invocation/CPU budget; see root-provider.tsx). The groups split
// by cost: `fast` is all DB-only detectors; the rest isolate the heavier ones
// (USDA-coverage, UPC) so no single invocation sums all the CPU. The two WASM
// parse-sweeps (stale parses, unused aliases) are NOT here — they re-parse every
// recipe line and blew the CPU/memory budget on the request path, so they live as
// manual dry-run/fix-all actions in Settings → Maintenance instead.
export const sectionTotalsSchema = z.record(z.string(), z.number().int());
export type SectionTotals = z.infer<typeof sectionTotalsSchema>;

export const importFindingProblemSchema = z.object({
  id: z.uuid(),
  purchaseId: purchaseShortcode.nullable(),
  kind: z.string(),
  summary: z.string(),
  probability: z.number().nullable(),
  proposedFix: proposedImportFix.nullable(),
  createdAt: z.date(),
});
export type ImportFindingProblem = z.infer<typeof importFindingProblemSchema>;

export const resolveImportFindingInput = z.object({
  id: z.uuid(),
  action: z.enum(["apply", "dismiss"]),
});
export type ResolveImportFindingInput = z.infer<
  typeof resolveImportFindingInput
>;

export const resolveImportFindingOut = z.object({
  id: z.uuid(),
  status: z.enum(["applied", "dismissed"]),
});

const problemsFastFields = {
  importFindings: z.array(importFindingProblemSchema),
  duplicateInventory: z.array(duplicateUniqueProductSchema),
  duplicateProductIdentities: z.array(duplicateProductIdentitySchema),
  orphanedProducts: z.array(orphanedProductSchema),
  partiallyImportedCookbooks: z.array(partiallyImportedCookbookSchema),
  soldButStillStocked: z.array(soldButStillStockedSchema),
  kitsCountedTwice: z.array(kitCountedTwiceSchema),
  unlinkedExitExpenses: z.array(unlinkedExitExpenseSchema),
  purchaselessExitExpenses: z.array(purchaselessExitExpenseSchema),
  toolsUsedOutsideOwnership: z.array(toolUsedOutsideOwnershipSchema),
  productsWithNoImages: z.array(productWithNoImagesSchema),
  imageProcessingIssues: z.array(imageProcessingProblemSchema),
  entitiesMissingEmbeddings: z.array(entityMissingEmbeddingSchema),
  staleParentRecipes: z.array(staleParentRecipeSchema),
  understatedCostMeals: z.array(understatedCostMealSchema),
  unknownParkedItems: z.array(unknownParkedItemSchema),
  inventoryWithoutPricePath: z.array(inventoryWithoutPricePathSchema),
  weightSoldProducts: z.array(weightSoldProductSchema),
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
  dependencyCycles: z.array(
    z.object({
      entity: z.enum(["project", "task"]),
      path: z.array(z.union([projectShortcode, taskShortcode])).min(2),
      description: z.string().min(1),
    }),
  ),
  incompleteStatementImports: z.array(incompleteStatementImportSchema),
};

export const problemsFastSchema = z.object({
  ...problemsFastFields,
  sectionTotals: sectionTotalsSchema,
});

// USDA-coverage detectors — share one product scan + USDA enrichment.
//
// `productsWithTitleDerivableSize` needs no USDA and no network, but it does
// run WASM per candidate, which is exactly what the `fast` lane's "DB-only,
// no WASM/network" contract excludes. It lives here rather than there because
// this is the lane that already tolerates a per-product WASM call, and because
// a WASM sweep on the cheap hot path is the specific mistake that took the
// Worker down once (see the parse-sweep note above `sectionTotalsSchema`).
const problemsCoverageFields = {
  ingredientsWithPartialCoverage: z.array(ingredientWithPartialCoverageSchema),
  productsWithIslandedMappings: z.array(productWithIslandedMappingsSchema),
  productsWithTitleDerivableSize: z.array(productWithTitleDerivableSizeSchema),
};

/**
 * The catalog-level truthfulness signal for filters backed by the conversion
 * projection. A ready row from another engine version is deliberately stale:
 * the list filters fail closed in that case, so reporting it as fresh would
 * turn a partial result into a healthy-looking empty Problem.
 */
export const conversionCoverageFreshnessSchema = z.object({
  state: z.enum(["fresh", "stale", "unavailable"]),
  computedAt: z.date().nullable(),
  expectedEngineVersion: z.string(),
  readyCount: z.number().int().nonnegative(),
  staleCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
});
export type ProductConversionCoverageFreshness = z.infer<
  typeof conversionCoverageFreshnessSchema
>;

export const problemsCoverageSchema = z.object({
  ...problemsCoverageFields,
  sectionTotals: sectionTotalsSchema,
  /** Exact list filters read this persisted projection, not the card scan. */
  freshness: conversionCoverageFreshnessSchema,
});

const problemsUpcFields = {
  productsWithBetterUpcData: z.array(productWithBetterUpcDataSchema),
};

/**
 * The UPC provider is advisory. Its status is part of the wire contract so an
 * outage cannot masquerade as a healthy empty proposal list.
 */
export const upcEnrichmentFreshnessSchema = z.object({
  status: z.enum(["fresh", "stale", "unavailable"]),
  checkedAt: z.date(),
  oldestFetchedAt: z.date().nullable(),
  unavailableCount: z.number().int().nonnegative(),
});
export type UpcEnrichmentFreshness = z.infer<
  typeof upcEnrichmentFreshnessSchema
>;

export const problemsUpcSchema = z.object({
  ...problemsUpcFields,
  sectionTotals: sectionTotalsSchema,
  freshness: upcEnrichmentFreshnessSchema,
});

const problemsViewsFields = {
  ingredientsWithoutProduct: z.array(ingredientWithoutProductSchema),
  staleLocations: z.array(staleLocationSchema),
  productsWithoutMappings: z.array(productWithoutMappingsSchema),
  productsMissingPrice: z.array(productMissingPriceSchema),
  unvaluedBucketProducts: z.array(productMissingPriceSchema),
  neverVerifiedInventory: z.array(neverVerifiedInventorySchema),
  locationsWithoutAiDescription: z.array(locationWithoutAiDescriptionSchema),
  emptyLocations: z.array(emptyLocationSchema),
  negativeExpectedQuantity: z.array(negativeExpectedQuantitySchema),
  unusedIngredientsWithProduct: z.array(unusedIngredientSchema),
  unusedIngredientsWithoutProduct: z.array(unusedIngredientSchema),
};

export const problemsViewsSchema = z.object({
  ...problemsViewsFields,
  /** True population per key; the page above is only what the card shows. */
  sectionTotals: sectionTotalsSchema,
});
export type ProblemsViewsOut = z.infer<typeof problemsViewsSchema>;

const problemsTrackerFields = {
  overdueTasks: z.array(projectAttentionItemSchema),
  stalledProjects: z.array(projectAttentionItemSchema),
  projectsMissingBudget: z.array(projectAttentionItemSchema),
  pastDuePlannedExpenses: z.array(projectAttentionItemSchema),
  unclassifiedExpenses: z.array(projectAttentionItemSchema),
  blockedWorkProjects: z.array(projectAttentionItemSchema),
  projectsWithDateDrift: z.array(projectAttentionItemSchema),
};

export const problemsTrackerSchema = z.object({
  ...problemsTrackerFields,
  sectionTotals: sectionTotalsSchema,
});
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
  ...problemsFastFields,
  ...problemsCoverageFields,
  ...problemsUpcFields,
  ...problemsTrackerFields,
  ...problemsViewsFields,
};

export const allProblemsSchema = z.object({
  ...allProblemArrayFields,
  sectionTotals: sectionTotalsSchema.default({}),
  upcFreshness: upcEnrichmentFreshnessSchema.optional(),
  conversionCoverageFreshness: conversionCoverageFreshnessSchema.optional(),
  totalProblems: z.number(),
});

const referentialLivenessViolationMcpOut =
  referentialLivenessViolationSchema.omit({
    targetId: true,
    sourceId: true,
  });

/** MCP problem catalog with storage-only diagnostic identifiers removed. */
export const allProblemsMcpSchema = allProblemsSchema.extend({
  referentialLivenessViolations: z.array(referentialLivenessViolationMcpOut),
});

export const referentialLivenessViolationsMcpOut = z.array(
  referentialLivenessViolationMcpOut,
);

export const EMPTY_SECTION_TOTALS: SectionTotals = Object.freeze({});

/**
 * How many rows a section really covers: its declared total when it reports a
 * sample, else the rows it returned. The single definition, so a caller can't
 * accidentally count a page.
 */
export const sectionSize = (
  key: string | undefined,
  items: readonly unknown[],
  totals: SectionTotals | undefined,
): number => (key ? (totals?.[key] ?? items.length) : items.length);

export type ProblemKey = keyof typeof allProblemArrayFields;

export type ProblemArrays = { [K in ProblemKey]: AllProblems[K] };

const problemArraysSchema = z.object(allProblemArrayFields);

/**
 * Every detector key at empty. The Problems page merges four separately-loaded
 * cost groups into one `AllProblems`, and a group that hasn't resolved yet has
 * to render as empty sections rather than as missing keys — spreading the
 * loaded groups over this derives every default from the group shapes, so a
 * new detector needs no edit at the merge site.
 *
 * The empty arrays are shared rather than rebuilt per merge: problem sections
 * are only ever read, and a stable identity keeps a not-yet-loaded group from
 * churning the memos downstream of the merge on every recompute.
 */
export const EMPTY_PROBLEM_ARRAYS: ProblemArrays = Object.freeze(
  problemArraysSchema.parse(
    Object.fromEntries(
      Object.keys(allProblemArrayFields).map((key) => [key, []]),
    ),
  ),
);

export const PROBLEM_CLASS = {
  importFindings: "defect",
  duplicateInventory: "defect",
  // Two rows for one SKU is unambiguously wrong — spend, stock, and identifiers
  // are split across both — and it converges to zero: `mergeProducts` folds the
  // cluster and the cluster never comes back. Same reasoning as
  // `duplicateVendors`. No auto-fix: which row survives decides which
  // identifiers and name stand, and there is no restore path.
  duplicateProductIdentities: "defect",
  orphanedProducts: "defect",
  partiallyImportedCookbooks: "defect",
  productsMissingPrice: "defect",
  // Unambiguously wrong and converges to zero: the item was sold, so the shelf
  // is stale and the location total is overstated by its full value. Not
  // `coverage` — there is no denominator and no reported row is legitimately
  // correct as it stands. No auto-fix: the entry is usually stale but may
  // instead mean the disposal was mis-recorded, and deleting inventory has no
  // restore path.
  soldButStillStocked: "defect",
  // Unambiguously wrong and converges to zero: the same physical thing is on
  // the books twice and inventory valuation is overstated by a whole kit.
  // Not `coverage` — there is no denominator, and no reported row is correct as
  // it stands. No auto-fix: which side is the mistake is the operator's call
  // (delete the parent's entry, or the parts', or fix the ledger), and deleting
  // inventory has no restore path.
  kitsCountedTwice: "defect",
  // A negative itemized principal line in a disposal Purchase with no Product
  // link. This is useful provenance coverage, but it is not uniformly a defect:
  // apparel, collectibles, and other deliberately untracked goods legitimately
  // remain productless. No auto-fix — guessing a Product would write false
  // ownership history that `soldButStillStocked` would then trust.
  unlinkedExitExpenses: "coverage",
  // Negative lines with no Purchase are also ambiguous coverage: a family
  // contribution or a neighbour's share of a shared cost can legitimately be
  // productless, while a hand-entered cash sale may need provenance. There is
  // no signal separating those cases, so keep every row available for review
  // without adding it to the defect count. No auto-fix for the same reason as
  // `unlinkedExitExpenses` above.
  purchaselessExitExpenses: "coverage",
  // Recorded exits exceed recorded acquisitions, but acquisition history is
  // intentionally incomplete for goods owned before Cubby's ledger began.
  // Keep the arithmetic visible as coverage without claiming that an inferred
  // acquisition should be invented. A human can add source-backed history or
  // correct a genuine quantity error when evidence exists.
  negativeExpectedQuantity: "coverage",
  // The edge asserts something that could not have happened, and the gate that
  // now rejects new ones means the list only shrinks. No auto-fix: detaching is
  // usually right, but a missing acquisition Expense produces the same row and
  // deleting the edge would bury the real defect.
  toolsUsedOutsideOwnership: "defect",
  productsWithoutMappings: "defect",
  // COVERAGE for the same reason as `productsWithTitleDerivableSize` below: a
  // household keeps buying weight-sold groceries, so new rows keep arriving no
  // matter how diligently the backlog is worked. Classing it `defect` would put
  // a standing population into the navbar badge, which is what that class is
  // meant to keep clear. Each row is still real work — the fix is a
  // weight-to-money mapping — it just never reaches zero and stays there.
  weightSoldProducts: "coverage",
  // COVERAGE, not defect, and the distinction is load-bearing: only `defect`
  // rows reach `totalProblems` and the navbar badge, and there are ~1,400 of
  // these. It is also genuinely never-zero — new products keep arriving with a
  // size in the title — which is the definition of coverage here.
  productsWithTitleDerivableSize: "coverage",
  unusedIngredientsWithProduct: "defect",
  unusedIngredientsWithoutProduct: "defect",
  locationsWithoutAiDescription: "defect",
  entitiesMissingEmbeddings: "defect",
  staleParentRecipes: "defect",
  // A cooked meal with nothing planned is unfinished, and it converges to zero
  // two ways: plan a recipe, or re-kind it to what it actually was. Not
  // `coverage` — there is no denominator and no backlog being worked through,
  // just a row that is either finished or mislabelled. No auto-fix: only the
  // cook knows which of the two resolutions is true.
  // The number on the meal is wrong, not merely unfinished, and it stays wrong
  // until someone gives an ingredient a price path. Converges to zero; no
  // auto-fix, because the fix is a pricing decision.
  understatedCostMeals: "defect",
  // A recipe you can't cook from. Converges to zero once typed in, and the
  // book/Notion sources that legitimately have none are excluded rather than
  // tolerated, so a row here is always real work.
  unknownParkedItems: "defect",
  // Priced product, unpriceable unit. Converges to zero (add the conversion
  // edge) and production sits at zero today, so a row is a regression in some
  // write path rather than a backlog — the `referentialLivenessViolations`
  // shape. No auto-fix: only a human knows how many rolls are in the pack.
  inventoryWithoutPricePath: "defect",
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
  // Project/Task blocked-by edges are DAGs. New writes are locked and checked,
  // so a reported cycle is out-of-band corruption that can make actionable
  // work and tracker chains contradict one another or terminate defensively.
  dependencyCycles: "defect",
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

  // Misc buckets are *expected* to be unpriced — the `product/unpriced-buckets` view
  // already partitions them out for exactly this reason; classing them here is
  // what finally keeps them out of the total.
  unvaluedBucketProducts: "coverage",
  ingredientsWithoutProduct: "coverage",
  emptyLocations: "coverage",
  staleLocations: "coverage",
  neverVerifiedInventory: "coverage",
  productsWithNoImages: "coverage",
  // Failed processing is actionable, while review-needed eligibility is an
  // intentionally ambiguous human worklist; keep both under one attention
  // section so the list and Problems page share one membership predicate.
  imageProcessingIssues: "coverage",
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

export type CoverageProblemKey = {
  [K in ProblemKey]: (typeof PROBLEM_CLASS)[K] extends "coverage" ? K : never;
}[ProblemKey];

const isDefectKey = (key: string): boolean =>
  Object.entries(PROBLEM_CLASS).some(
    ([candidate, problemClass]) =>
      candidate === key && problemClass === "defect",
  );

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

const byTypeFields = Object.fromEntries(
  Object.keys(allProblemArrayFields).map((k) => [k, z.number()]),
);

export const problemsCountSchema = z.object({
  /** Defect rows only — what the navbar badge and homepage banner show. */
  total: z.number().int(),
  /** Coverage-backlog rows, reported separately so they never inflate `total`. */
  coverageTotal: z.number().int(),
  byType: z.object(byTypeFields),
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
  productsWithNoImages: z.number(),
  /** Live leaf locations — the only ones that can hold inventory directly. */
  emptyLocations: z.number(),
  staleLocations: z.number(),
  neverVerifiedInventory: z.number(),
  ingredientsWithoutProduct: z.number(),
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
  const {
    totalProblems,
    sectionTotals,
    upcFreshness: _upcFreshness,
    conversionCoverageFreshness: _conversionCoverageFreshness,
  } = all;
  // Freshness metadata sits beside detector arrays in the aggregate contract.
  // Keep the mechanically-derived count roster arrays-only as promised.
  const arrays = problemArraysSchema.parse(
    Object.fromEntries(
      Object.entries(all).filter(([, value]) => Array.isArray(value)),
    ),
  );
  const byType = problemsCountSchema.shape.byType.parse(
    Object.fromEntries(
      Object.entries(arrays).map(([key, items]) => [
        key,
        sectionSize(key, items, sectionTotals),
      ]),
    ),
  );
  // `byType` stays the FULL roster (coverage keys included) so per-detector
  // consumers and the MCP `type` slices keep working; only the totals split.
  return {
    total: totalProblems,
    coverageTotal: sumProblemSections(arrays, "coverage", sectionTotals),
    byType,
  };
};

// Assemble the cost-grouped detector results into the combined AllProblems
// shape (with derived total). Shared so the merge + total live in one place —
// the MCP list_problems tool calls this directly over its own per-group
// scans. (The Problems page merges client-side in useProblemsData, which is
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
  const { sectionTotals: fastTotals, ...fastSections } = groups.fast;
  const {
    sectionTotals: coverageTotals,
    freshness: conversionCoverageFreshness,
    ...coverageSections
  } = groups.coverage;
  const {
    sectionTotals: upcTotals,
    freshness: _upcFreshness,
    ...upcSections
  } = groups.upc;
  const { sectionTotals: trackerTotals, ...trackerSections } = groups.tracker;
  const { sectionTotals: viewTotals, ...viewSections } = groups.views;
  const sectionTotals = {
    ...fastTotals,
    ...coverageTotals,
    ...upcTotals,
    ...trackerTotals,
    ...viewTotals,
  };
  const sections = {
    ...fastSections,
    ...coverageSections,
    ...upcSections,
    ...trackerSections,
    ...viewSections,
  };
  return {
    ...sections,
    sectionTotals,
    upcFreshness: groups.upc.freshness,
    conversionCoverageFreshness,
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
export type KitCountedTwice = z.infer<typeof kitCountedTwiceSchema>;
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
export type InventoryWithoutPricePath = z.infer<
  typeof inventoryWithoutPricePathSchema
>;
export type LabelVariant = z.infer<typeof labelVariantSchema>;
export type DuplicateVendor = z.infer<typeof duplicateVendorSchema>;
export type VendorWithoutLogo = z.infer<typeof vendorWithoutLogoSchema>;
export type ProductWithIslandedMappings = z.infer<
  typeof productWithIslandedMappingsSchema
>;
export type ProductWithTitleDerivableSize = z.infer<
  typeof productWithTitleDerivableSizeSchema
>;
export type LocationWithoutAiDescription = z.infer<
  typeof locationWithoutAiDescriptionSchema
>;
export type StaleIngredientParse = z.infer<typeof staleIngredientParseSchema>;
export type StaleParentRecipe = z.infer<typeof staleParentRecipeSchema>;
export type UnderstatedCostMeal = z.infer<typeof understatedCostMealSchema>;
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
  staleRecipeTotals: z.number().int(),
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

export const problemsReparseEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number(),
    total: z.number(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({ updated: z.number(), recipesAffected: z.number() }),
  }),
]);

export const problemsPruneAliasesEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number(),
    total: z.number(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({ pruned: z.number() }),
  }),
]);

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
    ingredientIds: z.array(ingredientShortcode).optional(),
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
