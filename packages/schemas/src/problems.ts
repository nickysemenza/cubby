import { z } from "zod";
import { amount, baseKind } from "./codec";
import { money, moneyNullable } from "./money";
import { shortcodeEntities, type ShortcodeEntity } from "./entity-manifest";
import { entityConnectionItem } from "./entity-connections";
import { referentialLivenessViolationSchema } from "./entity-integrity";
import { financialReconciliationFields } from "./financial-reconciliation";
import {
  anyShortcodeSchema,
  cookbookShortcode,
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
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

const problemRowEntity = z.enum(
  nonEmptyTuple<ShortcodeEntity>(shortcodeEntities),
);

const problemRowBadgeSchema = z.object({
  label: z.string(),
  /** Set when the badge names a record, so it links to that record. */
  entity: problemRowEntity.nullable(),
  id: publicEntityIdSchema.nullable(),
});

/**
 * The uniform Problems row: the flagged record (public shortcode) plus the
 * evidence line and badges its detector computed. Detectors whose section has
 * no inline fix return this; the page renders every such section the same way.
 */
export const problemRowSchema = z.object({
  entity: problemRowEntity,
  id: publicEntityIdSchema,
  name: z.string(),
  subtitle: z.string().nullable(),
  badges: z.array(problemRowBadgeSchema),
});
export type ProblemRow = z.infer<typeof problemRowSchema>;

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

/** Receiving is interactive; this only closes `arrived` once every product line landed. */
export const resolveArrivedFindingsInput = z.object({
  purchaseId: purchaseShortcode,
});
export const resolveArrivedFindingsOut = z.object({
  resolved: z.number().int().nonnegative(),
});

/**
 * Which cost-grouped query a detector runs in. `fast` is DB-only (no WASM, no
 * network); `coverage` tolerates a per-product WASM call; `upc` calls the UPC
 * provider; `tracker` is the project-attention rules; `views` are sampled
 * pages of entity-list views with true totals in `sectionTotals`.
 */
export type ProblemLane = "fast" | "coverage" | "upc" | "tracker" | "views";

/**
 * `defect` rows are unambiguously wrong and converge to zero; only they reach
 * `totalProblems` and the navbar badge. `coverage` rows are a standing backlog
 * (or ambiguous) and are counted separately.
 */
export type ProblemClass = "defect" | "coverage";

const detector = <
  const L extends ProblemLane,
  const C extends ProblemClass,
  I extends z.ZodType,
  const M extends string = never,
>(
  lane: L,
  problemClass: C,
  item: I,
  /** The `coverageTotalsSchema` key holding this detector's meter denominator. */
  meter?: M,
) => ({ lane, problemClass, item, meter });

/**
 * Every Problems detector: its cost lane, class, and row schema. The lane
 * schemas, `PROBLEM_CLASS`, the count payload, the coverage-meter totals, and
 * `ProblemItem` are all derived from this one table.
 */
export const problemDetectors = {
  // --- fast lane ---
  importFindings: detector("fast", "defect", importFindingProblemSchema),
  duplicateInventory: detector("fast", "defect", problemRowSchema),
  // Two rows for one SKU is unambiguously wrong — spend, stock, and identifiers
  // are split across both — and it converges to zero: `mergeProducts` folds the
  // cluster and the cluster never comes back. Same reasoning as
  // `duplicateVendors`. No auto-fix: which row survives decides which
  // identifiers and name stand, and there is no restore path.
  duplicateProductIdentities: detector(
    "fast",
    "defect",
    duplicateProductIdentitySchema,
  ),
  orphanedProducts: detector("fast", "defect", orphanedProductSchema),
  // Unambiguously wrong and converges to zero: a live record of a checked kind
  // (see `ORPHAN_CHECK_KINDS`) with no physical connection at all is nothing
  // in the house refers to it, same reasoning as `orphanedProducts` but read
  // from the generic EntityEdge source rather than a product-specific scan.
  // No auto-fix: which side is stale is an operator call.
  unconnectedEntities: detector("fast", "defect", entityConnectionItem),
  partiallyImportedCookbooks: detector(
    "fast",
    "defect",
    partiallyImportedCookbookSchema,
  ),
  // Unambiguously wrong and converges to zero: the item was sold, so the shelf
  // is stale and the location total is overstated by its full value. Not
  // `coverage` — there is no denominator and no reported row is legitimately
  // correct as it stands. No auto-fix: the entry is usually stale but may
  // instead mean the disposal was mis-recorded, and deleting inventory has no
  // restore path.
  soldButStillStocked: detector("fast", "defect", problemRowSchema),
  // Unambiguously wrong and converges to zero: the same physical thing is on
  // the books twice and inventory valuation is overstated by a whole kit.
  // Not `coverage` — there is no denominator, and no reported row is correct as
  // it stands. No auto-fix: which side is the mistake is the operator's call
  // (delete the parent's entry, or the parts', or fix the ledger), and deleting
  // inventory has no restore path.
  kitsCountedTwice: detector("fast", "defect", problemRowSchema),
  // A negative itemized principal line in a disposal Purchase with no Product
  // link. This is useful provenance coverage, but it is not uniformly a defect:
  // apparel, collectibles, and other deliberately untracked goods legitimately
  // remain productless. No auto-fix — guessing a Product would write false
  // ownership history that `soldButStillStocked` would then trust.
  unlinkedExitExpenses: detector("fast", "coverage", problemRowSchema),
  // Negative lines with no Purchase are also ambiguous coverage: a family
  // contribution or a neighbour's share of a shared cost can legitimately be
  // productless, while a hand-entered cash sale may need provenance. There is
  // no signal separating those cases, so keep every row available for review
  // without adding it to the defect count. No auto-fix for the same reason as
  // `unlinkedExitExpenses` above.
  purchaselessExitExpenses: detector("fast", "coverage", problemRowSchema),
  // The edge asserts something that could not have happened, and the gate that
  // now rejects new ones means the list only shrinks. No auto-fix: detaching is
  // usually right, but a missing acquisition Expense produces the same row and
  // deleting the edge would bury the real defect.
  toolsUsedOutsideOwnership: detector(
    "fast",
    "defect",
    toolUsedOutsideOwnershipSchema,
  ),
  productsWithNoImages: detector(
    "fast",
    "coverage",
    problemRowSchema,
    "productsWithNoImages",
  ),
  // Failed processing is actionable, while review-needed eligibility is an
  // intentionally ambiguous human worklist; keep both under one attention
  // section so the list and Problems page share one membership predicate.
  imageProcessingIssues: detector("fast", "coverage", problemRowSchema),
  entitiesMissingEmbeddings: detector(
    "fast",
    "defect",
    entityMissingEmbeddingSchema,
  ),
  staleParentRecipes: detector("fast", "defect", staleParentRecipeSchema),
  // A cooked meal with nothing planned is unfinished, and it converges to zero
  // two ways: plan a recipe, or re-kind it to what it actually was. Not
  // `coverage` — there is no denominator and no backlog being worked through,
  // just a row that is either finished or mislabelled. No auto-fix: only the
  // cook knows which of the two resolutions is true.
  // The number on the meal is wrong, not merely unfinished, and it stays wrong
  // until someone gives an ingredient a price path. Converges to zero; no
  // auto-fix, because the fix is a pricing decision.
  understatedCostMeals: detector("fast", "defect", understatedCostMealSchema),
  // A recipe you can't cook from. Converges to zero once typed in, and the
  // book/Notion sources that legitimately have none are excluded rather than
  // tolerated, so a row here is always real work.
  unknownParkedItems: detector("fast", "defect", problemRowSchema),
  // Priced product, unpriceable unit. Converges to zero (add the conversion
  // edge) and production sits at zero today, so a row is a regression in some
  // write path rather than a backlog — the `referentialLivenessViolations`
  // shape. No auto-fix: only a human knows how many rolls are in the pack.
  inventoryWithoutPricePath: detector("fast", "defect", problemRowSchema),
  // COVERAGE for the same reason as `productsWithTitleDerivableSize` below: a
  // household keeps buying weight-sold groceries, so new rows keep arriving no
  // matter how diligently the backlog is worked. Classing it `defect` would put
  // a standing population into the navbar badge, which is what that class is
  // meant to keep clear. Each row is still real work — the fix is a
  // weight-to-money mapping — it just never reaches zero and stays there.
  weightSoldProducts: detector("fast", "coverage", weightSoldProductSchema),
  manufacturerSpellingVariants: detector("fast", "defect", labelVariantSchema),
  // Two roster rows for one real vendor is simply wrong — that vendor's spend is
  // split across both — and it converges to zero: `mergeVendors` folds the pair
  // and the pair never comes back (the live roster sits at 0 across 114 vendors).
  // Not `coverage`: there is no backlog being worked through and no denominator,
  // and unlike `purchasesNotReconciling` a reported row is never legitimately
  // correct as it stands.
  duplicateVendors: detector("fast", "defect", duplicateVendorSchema),
  vendorsWithoutLogos: detector(
    "fast",
    "coverage",
    vendorWithoutLogoSchema,
    "vendorsWithPurchases",
  ),
  // Advisory, not backlog (see the note above): a purchase whose expenses disagree
  // with its stated total is often correct as-is, and the only mechanical "fix"
  // would be back-computing a cost from `statedTotal` — which nothing may do. So
  // it is reported, never counted, and never red.
  purchasesNotReconciling: detector(
    "fast",
    "coverage",
    purchaseNotReconcilingSchema,
  ),
  purchaseFinancialSettlementMismatches: detector(
    "fast",
    "coverage",
    purchaseFinancialSettlementMismatchSchema,
  ),
  // Advisory for a different reason than the two above: the match itself is a
  // heuristic. Amount + date is what finds these at all, and two unrelated things
  // legitimately cost the same on the same day, so a row here is a cue to look
  // rather than a fault. It is also the one detector whose "fix" destroys data
  // (delete the duplicate), which must never be mechanical or red.
  duplicateSpendCandidates: detector(
    "fast",
    "coverage",
    duplicateSpendCandidateSchema,
  ),
  duplicateFinancialTransactionSourceRefs: detector(
    "fast",
    "defect",
    duplicateFinancialTransactionSourceRefSchema,
  ),
  duplicateFinancialAccountSourceAliases: detector(
    "fast",
    "defect",
    duplicateFinancialAccountSourceAliasSchema,
  ),
  financialTransactionAllocationDefects: detector(
    "fast",
    "defect",
    financialTransactionAllocationDefectSchema,
  ),
  invalidFinancialJson: detector("fast", "defect", invalidFinancialJsonSchema),
  // A live row still pointing at a soft-deleted target — see
  // `findReferentialLivenessViolations`. DB-only and cheap (one UNION ALL over
  // 34 indexed FK joins), so it belongs in `fast` rather than earning its own
  // cost group: the expense is I/O, not the CPU the other groups isolate.
  // A dangling reference is unambiguously wrong and converges to zero — it can
  // only appear when a removal path forgets to detach, re-point, or cascade.
  // Production sat at zero when this detector landed, so any row is a real
  // regression rather than a backlog to work through. No auto-fix is offered:
  // clearing the FK and deleting the source row are both plausible and not
  // interchangeable, and picking wrong destroys data with no restore path.
  referentialLivenessViolations: detector(
    "fast",
    "defect",
    referentialLivenessViolationSchema,
  ),
  // Project/Task blocked-by edges are DAGs. New writes are locked and checked,
  // so a reported cycle is out-of-band corruption that can make actionable
  // work and tracker chains contradict one another or terminate defensively.
  dependencyCycles: detector(
    "fast",
    "defect",
    z.object({
      entity: z.enum(["project", "task"]),
      path: z.array(z.union([projectShortcode, taskShortcode])).min(2),
      description: z.string().min(1),
    }),
  ),
  incompleteStatementImports: detector(
    "fast",
    "defect",
    incompleteStatementImportSchema,
  ),
  // --- coverage lane ---
  // USDA-coverage detectors — share one product scan + USDA enrichment.
  //
  // `productsWithTitleDerivableSize` needs no USDA and no network, but it does
  // run WASM per candidate, which is exactly what the `fast` lane's "DB-only,
  // no WASM/network" contract excludes. It lives here rather than there because
  // this is the lane that already tolerates a per-product WASM call, and because
  // a WASM sweep on the cheap hot path is the specific mistake that took the
  // Worker down once (see the parse-sweep note above `sectionTotalsSchema`).
  ingredientsWithPartialCoverage: detector(
    "coverage",
    "defect",
    ingredientWithPartialCoverageSchema,
  ),
  productsWithIslandedMappings: detector(
    "coverage",
    "defect",
    productWithIslandedMappingsSchema,
  ),
  // COVERAGE, not defect, and the distinction is load-bearing: only `defect`
  // rows reach `totalProblems` and the navbar badge, and there are ~1,400 of
  // these. It is also genuinely never-zero — new products keep arriving with a
  // size in the title — which is the definition of coverage here.
  productsWithTitleDerivableSize: detector(
    "coverage",
    "coverage",
    productWithTitleDerivableSizeSchema,
  ),
  // --- upc lane ---
  productsWithBetterUpcData: detector(
    "upc",
    "defect",
    productWithBetterUpcDataSchema,
  ),
  // --- tracker lane ---
  overdueTasks: detector("tracker", "defect", projectAttentionItemSchema),
  stalledProjects: detector("tracker", "defect", projectAttentionItemSchema),
  projectsMissingBudget: detector(
    "tracker",
    "defect",
    projectAttentionItemSchema,
  ),
  pastDuePlannedExpenses: detector(
    "tracker",
    "defect",
    projectAttentionItemSchema,
  ),
  unclassifiedExpenses: detector(
    "tracker",
    "defect",
    projectAttentionItemSchema,
  ),
  blockedWorkProjects: detector(
    "tracker",
    "defect",
    projectAttentionItemSchema,
  ),
  projectsWithDateDrift: detector(
    "tracker",
    "defect",
    projectAttentionItemSchema,
  ),
  // --- views lane ---
  ingredientsWithoutProduct: detector(
    "views",
    "coverage",
    problemRowSchema,
    "ingredientsWithoutProduct",
  ),
  staleLocations: detector(
    "views",
    "coverage",
    problemRowSchema,
    "staleLocations",
  ),
  productsWithoutMappings: detector(
    "views",
    "defect",
    productWithoutMappingsSchema,
  ),
  productsMissingPrice: detector("views", "defect", problemRowSchema),
  // Misc buckets are *expected* to be unpriced — the `product/unpriced-buckets` view
  // already partitions them out for exactly this reason; classing them here is
  // what finally keeps them out of the total.
  unvaluedBucketProducts: detector("views", "coverage", problemRowSchema),
  neverVerifiedInventory: detector(
    "views",
    "coverage",
    problemRowSchema,
    "neverVerifiedInventory",
  ),
  locationsWithoutAiDescription: detector("views", "defect", problemRowSchema),
  // Meter denominator: live leaf locations — the only ones that can hold
  // inventory directly.
  emptyLocations: detector(
    "views",
    "coverage",
    emptyLocationSchema,
    "emptyLocations",
  ),
  // Recorded exits exceed recorded acquisitions, but acquisition history is
  // intentionally incomplete for goods owned before Cubby's ledger began.
  // Keep the arithmetic visible as coverage without claiming that an inferred
  // acquisition should be invented. A human can add source-backed history or
  // correct a genuine quantity error when evidence exists.
  negativeExpectedQuantity: detector("views", "coverage", problemRowSchema),
  unusedIngredientsWithProduct: detector("views", "defect", problemRowSchema),
  unusedIngredientsWithoutProduct: detector(
    "views",
    "defect",
    problemRowSchema,
  ),
};

type Detectors = typeof problemDetectors;
export type ProblemKey = keyof Detectors;
/** The row type a detector returns. */
export type ProblemItem<K extends ProblemKey> = z.infer<Detectors[K]["item"]>;
type ProblemRows<K extends ProblemKey> = z.ZodArray<Detectors[K]["item"]>;
type LaneKey<L extends ProblemLane> = {
  [K in ProblemKey]: Detectors[K]["lane"] extends L ? K : never;
}[ProblemKey];

const detectorEntries = Object.entries(problemDetectors);

const mapDetectors = <T>(
  keep: (entry: Detectors[ProblemKey]) => boolean,
  value: (entry: Detectors[ProblemKey]) => T,
): Record<string, T> =>
  Object.fromEntries(
    detectorEntries.flatMap(([key, entry]) =>
      keep(entry) ? [[key, value(entry)]] : [],
    ),
  );

const laneFields = <L extends ProblemLane>(
  lane: L,
): { [K in LaneKey<L>]: ProblemRows<K> } =>
  // SAFETY: exactly the detectors whose lane is L, each keyed by its own name
  // with `z.array` of its own item schema.
  mapDetectors(
    (entry) => entry.lane === lane,
    (entry) => z.array(entry.item),
  ) as { [K in LaneKey<L>]: ProblemRows<K> };

const problemsFastFields = laneFields("fast");
const problemsCoverageFields = laneFields("coverage");
const problemsUpcFields = laneFields("upc");
const problemsTrackerFields = laneFields("tracker");
const problemsViewsFields = laneFields("views");

export const problemsFastSchema = z.object({
  ...problemsFastFields,
  sectionTotals: sectionTotalsSchema,
});

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
export const problemsViewsSchema = z.object({
  ...problemsViewsFields,
  /** True population per key; the page above is only what the card shows. */
  sectionTotals: sectionTotalsSchema,
});
export type ProblemsViewsOut = z.infer<typeof problemsViewsSchema>;
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

// Combined output schema for all problems: every detector key is required, so
// lazy loading/cost grouping never makes fields appear optional on the
// aggregate response.
const allProblemArrayFields = {
  ...problemsFastFields,
  ...problemsCoverageFields,
  ...problemsUpcFields,
  ...problemsTrackerFields,
  ...problemsViewsFields,
} satisfies { [K in ProblemKey]: ProblemRows<K> };

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

// SAFETY: every detector keyed by name with its own declared class.
const problemClasses = mapDetectors(
  () => true,
  (entry) => entry.problemClass,
) as { [K in ProblemKey]: Detectors[K]["problemClass"] };
export { problemClasses as PROBLEM_CLASS };

export type CoverageProblemKey = {
  [K in ProblemKey]: Detectors[K]["problemClass"] extends "coverage"
    ? K
    : never;
}[ProblemKey];

const isDefectKey = (key: string): boolean =>
  detectorEntries.some(
    ([candidate, entry]) =>
      candidate === key && entry.problemClass === "defect",
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

// SAFETY: one `z.number()` per detector key.
const byTypeFields = mapDetectors(
  () => true,
  () => z.number(),
) as { [K in ProblemKey]: z.ZodNumber };

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
 * population count that nothing else computes. Keyed by each detector's
 * declared `meter`, so a meter can't be wired to the wrong denominator.
 *
 * Deliberately its OWN schema and procedure rather than a field on
 * `problemsFastShape`: `allProblemArrayFields` must stay arrays-only, or the
 * mechanically-derived `byTypeShape` and `countProblems` both break on a
 * non-array key. `unvaluedBucketProducts` is absent on purpose — a misc bucket
 * has no meaningful population to be a fraction of, so it renders as a plain
 * list.
 */
export const coverageTotalsSchema = z.object(
  // SAFETY: keyed by each metered detector's declared `meter` name.
  Object.fromEntries(
    detectorEntries.flatMap(([, entry]) =>
      entry.meter ? [[entry.meter, z.number()]] : [],
    ),
  ) as {
    [K in ProblemKey as NonNullable<Detectors[K]["meter"]>]: z.ZodNumber;
  },
);
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
export type IngredientWithUnusedAliases = z.infer<
  typeof ingredientWithUnusedAliasesSchema
>;
export type StaleIngredientParse = z.infer<typeof staleIngredientParseSchema>;

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
