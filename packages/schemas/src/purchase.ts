import { z } from "zod";
import { productMovementKind } from "./product-movement-kind";
import { financialTransactionOut } from "./financial-transaction";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { generatedPurchaseFieldSchemas } from "./generated/entity-field-schemas.purchase.gen";
import { uniqueBy } from "./base-entity";
import {
  expenseShortcode,
  financialTransactionShortcode,
  imageShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  spendingCategoryShortcode,
  vendorShortcode,
} from "./identifiers";
import { expenseLineKindSchema } from "./expense-line-kind";
import {
  createPaginatedResponseSchema,
  entityFilterList,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { money, moneyNullable } from "./money";
import {
  costTypeSchema,
  expenseOut,
  PRODUCT_QUANTITY_DESCRIPTION,
  tradeSchema,
} from "./project";
import {
  purchaseBaseFilterFields,
  purchaseOut,
} from "./generated/purchase.gen";

/**
 * The purchase read shape is exactly the declaration's read projection —
 * every computed field (vendor join, order URL, expense rollups,
 * reconciliation, documents) is declared there with its constraints.
 */
export {
  purchaseOut,
  purchaseListItemOut,
  type PurchaseOut,
  type PurchaseListItemOut,
} from "./generated/purchase.gen";

export const splitExpenseOut = z.array(expenseOut);

/** One allocation row as typed: the Purchase code (blank until chosen) and a dollar amount. */
export const settlementAllocationDraft = z.object({
  purchaseId: z.string(),
  amount: z.string(),
});
export type SettlementAllocationDraft = z.infer<
  typeof settlementAllocationDraft
>;

export const purchaseSettlementAllocationCheckInput = z.object({
  transactionId: financialTransactionShortcode,
  allocations: z.array(settlementAllocationDraft).max(50),
});
export const purchaseSettlementAllocationCheckOut = z.object({
  /** The rows to save as `financialTransaction.update` allocations; null while they cannot be. */
  allocations: z
    .array(z.object({ purchaseId: purchaseShortcode, amount: z.number() }))
    .nullable(),
  /** Dollars the valid rows add up to. */
  allocatedTotal: z.number(),
  /** Dollars still to allocate; negative when over-allocated. */
  remaining: z.number(),
  /** Why the rows cannot be saved yet; null when they can. */
  reason: z.string().nullable(),
});

export const purchaseSettlementCandidatesInput = z.object({
  purchaseId: purchaseShortcode,
});

export const purchaseSettlementCandidate = z.object({
  transaction: financialTransactionOut,
  days: z.number().int().min(0).max(45),
  merchantMatches: z.boolean(),
  exactAmount: z.boolean(),
  title: z.string(),
  /** The description under the title, already worded. */
  lines: z.array(z.string()),
  /**
   * The rows to start allocating this entry from: this order up to its stated total, the
   * remainder (blank Purchase) for another. A draft, not a settlement.
   */
  proposedAllocations: z.array(settlementAllocationDraft),
});

export const purchaseSettlementCandidatesOut = z.object({
  advisory: z
    .literal(true)
    .describe(
      "Suggestions only: reading candidates does not allocate settlement evidence or change the Expense ledger. Review and explicitly save allocations separately.",
    ),
  /** Why there is nothing to review, or why the list is empty; null when there are candidates. */
  message: z.string().nullable(),
  candidates: z.array(purchaseSettlementCandidate).max(10),
  /**
   * The candidates tied at the top deterministic rank, or empty unless two or more are tied. Only
   * then is "Suggest a match" offered.
   */
  tiedTransactionIds: z.array(financialTransactionShortcode),
  /** What to say before a suggestion is asked for; null when none is offered. */
  suggestHint: z.string().nullable(),
});

/** Deterministic rank tier: an exact stated-total charge outranks a vendor-name
 * match, which outranks a bare date-proximity hit (the repo orders by exactly
 * these two flags before days). */
function settlementTier(candidate: {
  exactAmount: boolean;
  merchantMatches: boolean;
}): number {
  return (candidate.exactAmount ? 2 : 0) + (candidate.merchantMatches ? 1 : 0);
}

/**
 * The candidates tied at the top deterministic tier, or `[]` unless two or
 * more are tied. Days-apart only breaks ties inside the repo ordering, so it
 * does not separate a tier: a person has no better reason to prefer the
 * nearer of two equally plausible charges. Both the server (before it spends
 * a model call) and the review UI (before it offers the button) use this.
 */
export function tiedTopSettlementCandidates<
  T extends { exactAmount: boolean; merchantMatches: boolean },
>(candidates: readonly T[]): T[] {
  const top = Math.max(-1, ...candidates.map(settlementTier));
  const tied = candidates.filter((c) => settlementTier(c) === top);
  return tied.length >= 2 ? tied : [];
}

export const purchaseSettlementSuggestInput = z.object({
  purchaseId: purchaseShortcode,
});

export const purchaseSettlementSuggestOut = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("not_ambiguous"),
    // `note` throughout: what to tell the person, already worded.
    note: z.string(),
  }),
  z.object({
    status: z.literal("unavailable"),
    error: z.string().describe("Raw diagnostic from the failed model call."),
    note: z.string(),
  }),
  z.object({
    status: z.literal("ranked"),
    advisory: z
      .literal(true)
      .describe(
        "A ranking of the tied candidates only; it never allocates settlement evidence.",
      ),
    selectedTransactionId: financialTransactionShortcode
      .nullable()
      .describe("The model's pick, or null when it judged none a fit."),
    ranked: z
      .array(
        z.object({
          transactionId: financialTransactionShortcode,
          probability: z.number().min(0).max(1),
          // The label to show on the candidate (`Suggested · 72%`).
          badge: z.string(),
        }),
      )
      .max(10),
    // Every candidate in the order to show: tied ones by probability, then the rest as listed.
    displayOrder: z.array(financialTransactionShortcode),
    note: z.string(),
  }),
]);
export type PurchaseSettlementCandidatesOut = z.infer<
  typeof purchaseSettlementCandidatesOut
>;
export type PurchaseSettlementSuggestOut = z.infer<
  typeof purchaseSettlementSuggestOut
>;

const purchaseCreateFields = {
  ...generatedPurchaseFieldSchemas.create,
  /**
   * Newly-uploaded document ids awaiting association. The
   * `PendingDocumentUpload` widget pushes the file to R2 first and hands back a
   * PENDING image's public `IMG-` shortcode; it only becomes a real attachment
   * when a save carries it here. Without this an uploaded invoice sits
   * unassociated and gets culled in 24 hours. `Image` mints a shortcode at
   * insert time, so the repo layer resolves this to a uuid before the
   * join-table write.
   */
  pendingImageIds: z.array(imageShortcode).optional(),
};

export const purchaseCreateInput = z.object(purchaseCreateFields);
export type PurchaseCreateInput = z.infer<typeof purchaseCreateInput>;

/**
 * A partial update makes every create field optional. `removeImageIds` /
 * `imageOrder` are update-only — you can't reorder or detach a document on a
 * purchase that doesn't exist yet — so they come in through `extend`, exactly as
 * `productUpdateData` does.
 */
export const purchaseUpdateData = z.object({
  ...generatedPurchaseFieldSchemas.update,
  // Public `IMG-` codes — these name documents `get_purchase`/`getPurchaseByID`
  // already handed back through `PurchaseOut.images[].id`, so a client passes
  // one straight back. The repo resolves it to a uuid before it reaches the
  // `PurchaseImage` join table.
  removeImageIds: z
    .array(imageShortcode)
    .optional()
    .describe(
      "Document ids to detach. Detaching DELETES the stored file when nothing else references it — there is no restore, and the id will not resolve again.",
    ),
  imageOrder: z
    .array(imageShortcode)
    .optional()
    .describe("existing document ids in display order"),
});
export type PurchaseUpdateData = z.infer<typeof purchaseUpdateData>;
export const purchaseUpdateInput = z.object({
  id: purchaseShortcode,
  data: purchaseUpdateData,
});
export type PurchaseUpdateInput = z.infer<typeof purchaseUpdateInput>;

export const purchaseExpenseStatus = z.enum(["empty", "unpriced", "priced"]);
export type PurchaseExpenseStatus = z.infer<typeof purchaseExpenseStatus>;

export const purchaseReconciliation = z.enum([
  "unknown",
  "match",
  "refund_adjusted",
  "mismatch",
]);
export type PurchaseReconciliation = z.infer<typeof purchaseReconciliation>;

export const purchaseDocumentKindValues = [
  "order_confirmation",
  "sales_order",
  "invoice",
  "receipt",
  "payment_receipt",
  "credit_memo",
  "return_authorization",
  "quote",
  "estimate",
  "contract",
  "statement",
  "specification",
  "other",
] as const;
export const purchaseDocumentKind = z.enum(purchaseDocumentKindValues);
export type PurchaseDocumentKind = z.infer<typeof purchaseDocumentKind>;

export const primaryPurchaseDocumentKinds = [
  "order_confirmation",
  "sales_order",
  "invoice",
  "receipt",
] as const satisfies readonly PurchaseDocumentKind[];

export const purchaseFilterFields = {
  ...purchaseBaseFilterFields,
  vendorId: entityFilterList(vendorShortcode).optional(),
  orderId: oneOrMany(z.string()).optional(),
  /** `"none"` matches purchases with no order id — the ~40% the vendor never issued one for. */
  orderIdPresenceFilter: presenceFilter,
  expenseStatus: oneOrMany(purchaseExpenseStatus).optional(),
  /** Shared soft verdict over statedTotal versus SUM(expense.cost). */
  reconciliation: oneOrMany(purchaseReconciliation).optional(),
  financialReconciliation: z.enum(["mismatch"]).optional(),
  documentPresenceFilter: presenceFilter,
};
export const purchaseFiltersSchema = z.object(purchaseFilterFields);
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;

export type PurchaseSortField = GeneratedEntitySortField<"purchase">;

export const purchaseListResponse = createPaginatedResponseSchema(purchaseOut);
export type PurchaseListResponse = z.infer<typeof purchaseListResponse>;

export const reclassifyPurchaseDocumentInput = z.object({
  purchaseId: purchaseShortcode,
  // Public `IMG-` code, as returned by `PurchaseOut.images[].id` — resolved to
  // a uuid in the repo before it's compared against `PurchaseImage.imageId`.
  imageId: imageShortcode,
  documentKind: purchaseDocumentKind,
});
export type ReclassifyPurchaseDocumentInput = z.infer<
  typeof reclassifyPurchaseDocumentInput
>;

/**
 * `sum(expenses)` vs `statedTotal`, as a **soft** flag. Nothing rejects a write
 * and nothing back-computes a cost from it — mismatch is often correct.
 * `"unknown"` when no `statedTotal` has been recorded.
 */
/**
 * Dollars of slack tolerated before `statedTotal` reads as a mismatch.
 *
 * Its reconciliation twin on the ledger side is `HOUSE_TAX_RATE` in ./project,
 * which lives there rather than here because this module imports from that one.
 */
export const RECONCILIATION_TOLERANCE = 0.01;

export const reconcilePurchase = (p: {
  statedTotal: number | null;
  expenseTotal: number;
  expenseCount?: number;
  unpricedExpenseCount?: number;
  postedRefundTotal?: number;
  financialReconciliation?: { postedRefundTotal: number };
}): PurchaseReconciliation => {
  if (p.statedTotal === null) return "unknown";
  const toleranceInCents = Math.round(RECONCILIATION_TOLERANCE * 100);
  const deltaInCents =
    Math.round(p.expenseTotal * 100) - Math.round(p.statedTotal * 100);
  if (Math.abs(deltaInCents) <= toleranceInCents) return "match";

  // A purchase with no expense lines at all has nothing to reconcile: the whole
  // stated total reads as a gap, so `mismatch` fired on every freshly created
  // Purchase and — being the only `defect`-kind purchase check — made it report
  // `dataQuality.status: "defect"` before anyone had a chance to book a line.
  // `empty_expenses` already describes that state, and describes it correctly.
  // Callers that cannot count expenses omit `expenseCount` and keep the old
  // behaviour.
  if (p.expenseCount === 0) return "unknown";

  const postedRefundInCents = Math.round(
    (p.postedRefundTotal ?? p.financialReconciliation?.postedRefundTotal ?? 0) *
      100,
  );
  if (
    (p.unpricedExpenseCount ?? 0) === 0 &&
    deltaInCents < -toleranceInCents &&
    postedRefundInCents === deltaInCents
  ) {
    return "refund_adjusted";
  }

  return "mismatch";
};

/**
 * One invoice spanning trades — Flow Form Plumbing's $2,516 covering both
 * rough-in and fixtures. Explicitly **not** for payment schedules: those are
 * separate transactions, so they are separate Purchases.
 */
export const linkExpensesToPurchaseInput = z.object({
  purchaseId: purchaseShortcode,
  expenseIds: z.array(expenseShortcode).min(1),
});
export type LinkExpensesToPurchaseInput = z.infer<
  typeof linkExpensesToPurchaseInput
>;

export const MAX_SPLIT_EXPENSE_PARTS = 100;

export const splitExpenseInput = z.object({
  expenseId: expenseShortcode,
  /**
   * Required by the write path when the original has explicit household
   * attribution. Copying those weights to every part and clearing them are
   * both defensible, but neither is a safe implicit default.
   */
  attributionPolicy: z.enum(["inherit", "clear"]).optional(),
  parts: z
    .array(
      z.object({
        name: z.string().min(1),
        // Deliberately unconstrained, not `positiveMoney` — a split part can
        // carry a negative cost (e.g. splitting off a refund/credit line),
        // matching the parent Expense.cost it divides. See
        // negative-expenses-family-contributions in memory.
        cost: money,
        lineKind: expenseLineKindSchema.optional(),
        costType: costTypeSchema,
        spendingCategoryId: spendingCategoryShortcode
          .nullable()
          .optional()
          .describe(
            "Omit to preserve the original stored override; pass null to use inherited classification, or a category to explicitly classify this part.",
          ),
        trade: tradeSchema.nullable(),
        projectId: projectShortcode.nullable().default(null),
        productId: productShortcode.nullable().default(null),
        // Signed, zero only on a negative cost — same rule as
        // `Expense.productQuantity`. The cost-dependent half is enforced by
        // `assertQuantitySignMatchesCost` on the write path.
        productQuantity: z
          .number()
          .nullable()
          .default(null)
          .describe(PRODUCT_QUANTITY_DESCRIPTION),
        notes: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Omit to inherit the original Expense notes; pass null to clear them for this part.",
          ),
      }),
    )
    .min(2)
    .max(MAX_SPLIT_EXPENSE_PARTS),
});
export type SplitExpenseInput = z.infer<typeof splitExpenseInput>;

export type SplitExpenseDelta = {
  originalCost: number | null;
  partsSum: number;
  delta: number | null;
};

export const splitExpenseDelta = (
  originalCost: number | null,
  partCosts: number[],
): SplitExpenseDelta => {
  const partsSumCents = partCosts.reduce(
    (sum, cost) => sum + Math.round(cost * 100),
    0,
  );
  const partsSum = partsSumCents / 100;
  if (originalCost === null) {
    return { originalCost: null, partsSum, delta: null };
  }
  const deltaCents = partsSumCents - Math.round(originalCost * 100);
  return { originalCost, partsSum, delta: deltaCents / 100 };
};

/**
 * The words a split and its checks share, so web, native and the write path never describe the
 * same refusal differently.
 */
export const SPLIT_NEEDS_PURCHASE_REASON =
  "Record this expense's vendor first — a split files its parts under the same purchase.";

/**
 * One part as typed: every field a person edits stays text or a plain choice, so a half-typed
 * amount is representable. `projectId` is blank for none; `keepProduct` hands the original's
 * product link to this part (at most one part).
 */
export const splitPartDraft = z.object({
  name: z.string(),
  cost: z.string(),
  costType: costTypeSchema,
  trade: tradeSchema.nullable(),
  projectId: z.string(),
  keepProduct: z.boolean(),
  productQuantity: z.string(),
});
export type SplitPartDraft = z.infer<typeof splitPartDraft>;

export const purchaseSplitStartInput = z.object({
  expenseId: expenseShortcode,
});
export const purchaseSplitStartOut = z.object({
  title: z.string(),
  /** What a split does, worded once: the parts replace the expense. */
  description: z.string(),
  /** The sentence an explicit confirmation shows before the write. */
  confirm: z.string(),
  originalCost: z.number().nullable(),
  /** The linked product a part can inherit; null when the expense has none. */
  productName: z.string().nullable(),
  /** The note under the parts when a product can be handed to one part. */
  productNote: z.string().nullable(),
  maxParts: z.number().int(),
  /** The rows to start from: the whole cost on the first part, the second empty. */
  parts: z.array(splitPartDraft),
});

export const splitAttributionPolicy = z.enum(["inherit", "clear"]);

export const purchaseSplitCheckInput = z.object({
  expenseId: expenseShortcode,
  attributionPolicy: splitAttributionPolicy.optional(),
  parts: z.array(splitPartDraft).max(MAX_SPLIT_EXPENSE_PARTS),
});
export const purchaseSplitCheckOut = z.object({
  /** The exact body to send to `purchase.split`; null while the parts cannot be saved. */
  split: splitExpenseInput.nullable(),
  /** Dollars the parts add up to, in whole cents. */
  partsTotal: z.number(),
  originalCost: z.number().nullable(),
  /** `partsTotal` minus `originalCost`; null when the original has no cost. */
  delta: z.number().nullable(),
  /** Why the parts cannot be saved yet; null when they can. */
  reason: z.string().nullable(),
  /** The line under the totals, already worded. */
  note: z.string(),
  /** True when the original carries household attribution and a policy has not been chosen. */
  needsAttributionPolicy: z.boolean(),
});

export const linkExpenseScope = z.enum([
  "vendorOrUnattached",
  "unattached",
  "any",
]);
export type LinkExpenseScope = z.infer<typeof linkExpenseScope>;

export const purchaseLinkExpensesCandidatesInput = z.object({
  purchaseId: purchaseShortcode,
  scope: linkExpenseScope.default("vendorOrUnattached"),
  search: z.string().optional(),
});
export const purchaseLinkExpenseCandidate = z.object({
  id: expenseShortcode,
  name: z.string(),
  date: z.string().nullable(),
  cost: z.number().nullable(),
  trade: tradeSchema.nullable(),
  projectId: projectShortcode.nullable(),
  projectName: z.string().nullable(),
  /** Where it is filed now: "unattached", or the vendor of its current purchase. */
  current: z.string(),
  /** True when attaching moves it off another purchase. */
  filed: z.boolean(),
  /** The line under the name, already worded. */
  summary: z.string(),
});
export const purchaseLinkExpensesCandidatesOut = z.object({
  scopes: z.array(z.object({ value: linkExpenseScope, label: z.string() })),
  candidates: z.array(purchaseLinkExpenseCandidate),
  /** Why the list is empty; null when it is not. */
  message: z.string().nullable(),
  /** The standing caution under the list. */
  caution: z.string(),
});

export const purchaseLinkExpensesCheckInput = z.object({
  purchaseId: purchaseShortcode,
  expenseIds: z.array(expenseShortcode).max(500),
});
export const purchaseLinkExpensesCheckOut = z.object({
  /** The ids to send to `purchase.link`; null while nothing valid is selected. */
  expenseIds: z.array(expenseShortcode).nullable(),
  selectedCount: z.number().int(),
  /** Dollars the selected expenses add up to; those without a cost add nothing. */
  selectedTotal: z.number(),
  /** The purchase's expense total once they are attached; null when nothing is selected. */
  resultingTotal: z.number().nullable(),
  /** How many selected expenses would move off another purchase. */
  movedCount: z.number().int(),
  reason: z.string().nullable(),
  /** The line under the selection, already worded. */
  note: z.string().nullable(),
  /** Set when attaching moves expenses off another purchase: the sentence to confirm. */
  confirm: z.string().nullable(),
});

export const purchaseLinkProductsCandidatesInput = z.object({
  purchaseId: purchaseShortcode,
  search: z.string().optional(),
});
/** A product offered for attaching: what the picker shows, no more. */
export const purchaseLinkProductCandidate = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  price: z.number().nullable(),
  coverImageUrl: z.string().nullable(),
});
export const purchaseLinkProductsCandidatesOut = z.object({
  candidates: z.array(purchaseLinkProductCandidate),
  message: z.string().nullable(),
  /** What attaching does and does not record. */
  note: z.string(),
});
export const purchaseAttachProductsInput = z.object({
  purchaseId: purchaseShortcode,
  productIds: z.array(productShortcode).min(1).max(200),
});

/** Agent-safe Purchase deletion: only already-empty vendor events qualify. */
export const deleteEmptyPurchasesInput = z.strictObject({
  ids: z
    .array(purchaseShortcode)
    .min(1)
    .max(200)
    .refine(...uniqueBy((id) => id, "ids must not contain duplicates")),
});
export type DeleteEmptyPurchasesInput = z.infer<
  typeof deleteEmptyPurchasesInput
>;

export const deleteEmptyPurchasesOut = z.object({
  deleted: z.number().int().nonnegative(),
  deletedIds: z.array(purchaseShortcode),
});
export type DeleteEmptyPurchasesOut = z.infer<typeof deleteEmptyPurchasesOut>;

/**
 * What a purchase merge actually moved.
 *
 * Added so `merge_entity` can report a MEASURED `merged` count for purchases
 * like it does for the other three. The count is read back from the bulk
 * soft-delete's own `.returning()` rather than from `mergeIds.length`, which
 * would just quote the request back. Purchase's losers are soft-deleted before
 * `foldChargeInto` runs (the partial unique index needs the slot vacated), so
 * the count cannot come from `finalizeMerge` the way the others do.
 */
export const mergePurchasesOut = z.object({
  purchase: purchaseOut,
  mergeSummary: z.object({
    keepId: purchaseShortcode,
    /** Merged-away purchase rows, now soft-deleted tombstones. */
    deletedIds: z.array(purchaseShortcode),
    merged: z.number().int().nonnegative(),
  }),
});
export type MergePurchasesOut = z.infer<typeof mergePurchasesOut>;

export const mergePurchasesInput = z.object({
  keepId: purchaseShortcode,
  mergeIds: z.array(purchaseShortcode).min(1),
});
export type MergePurchasesInput = z.infer<typeof mergePurchasesInput>;

export const purchaseProductsInput = z.object({
  purchaseId: purchaseShortcode,
});

export const productPurchasesInput = z.object({
  productId: productShortcode,
});

/**
 * How a purchase⟷product row came to exist.
 *
 * `"link"` is an explicit `purchaseProduct` link — the sparse provenance edge
 * that exists for allocation-basis orders, whose Expenses can never carry a
 * `productId`. `"expense"` is derived: any live product-linked Expense on that
 * purchase names that product, including a planned line. `"both"` is a pair
 * carrying each edge.
 *
 * Three values rather than a boolean because the overlap is real and neither
 * half may be hidden: only a row with a link can be detached, and only an
 * expense-backed row survives that detach still relating the two.
 */
export const purchaseProductSource = z.enum(["expense", "link", "both"]);
export type PurchaseProductSource = z.infer<typeof purchaseProductSource>;

/**
 * When the explicit link was recorded, or null on an expense-derived row —
 * which has no link to stamp. Deliberately NOT backfilled from the Expense's
 * own `createdAt`: that would report a link time that never happened.
 *
 * This is the detachability test. `source` names where a row came from;
 * `linkAttachedAt !== null` is what says a link exists to remove.
 */
const linkAttachedAt = z.date().nullable();

export const purchaseProductOut = z.object({
  productId: productShortcode,
  productName: z.string(),
  manufacturer: z.string(),
  price: moneyNullable.describe(
    "Effective valuation/costing price — display only, not spend.",
  ),
  coverImageUrl: z.url().nullable(),
  source: purchaseProductSource,
  linkAttachedAt,
  movementKinds: z
    .array(productMovementKind)
    .describe(
      "Distinct recorded movement kinds from nonfuture Expenses; an explicit link proves no movement.",
    ),
  hasPlanned: z
    .boolean()
    .describe("At least one live future Expense names this pair."),
  componentCount: z.number().int().nonnegative(),
});
export type PurchaseProductOut = z.infer<typeof purchaseProductOut>;
export const purchaseProductsOut = z.array(purchaseProductOut);

export const productPurchaseOut = z.object({
  purchaseId: purchaseShortcode,
  displayLabel: z.string().nullable(),
  date: generatedPurchaseFieldSchemas.read.date,
  vendorName: z.string().nullable(),
  orderId: z.string().nullable(),
  source: purchaseProductSource,
  linkAttachedAt,
  movementKinds: z
    .array(productMovementKind)
    .describe(
      "Distinct recorded movement kinds from nonfuture Expenses; an explicit link proves no movement.",
    ),
  hasPlanned: z
    .boolean()
    .describe("At least one live future Expense names this pair."),
});
export type ProductPurchaseOut = z.infer<typeof productPurchaseOut>;
export const productPurchasesOut = z.array(productPurchaseOut);
