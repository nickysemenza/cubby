import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
  uniqueBy,
} from "./base-entity";
import { relationMutationOut } from "./common";
import { dataCheck, dataQuality, dataQualityStatus } from "./data-quality";
import {
  expenseShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "./identifiers";
import { financialReconciliationSummary } from "./financial-reconciliation";
import { imageUrlSummary } from "./image-summary";
import { expenseLineKindSchema } from "./expense-line-kind";
import { purchaseRelatedFilterFields } from "./related-view";
import {
  createItemsResponseSchema,
  createPaginatedResponseSchema,
  entityFilterList,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { money, moneyNullable, wholeCentAmount } from "./money";
import {
  costTypeSchema,
  plainDate,
  PRODUCT_QUANTITY_DESCRIPTION,
  tradeSchema,
} from "./project";

/**
 * Purchase — one vendor order, receipt, or deliberately separate purchase
 * event, and the home for purchase-level truth:
 * its stated total, documents, and identity.
 *
 * `Vendor ──< Purchase ──< Expense`. A purchase is identified by its `orderId`
 * when the vendor issues one, and is otherwise one per expense row. **All money
 * lives on `expense`** — every `SUM(cost)` in the codebase reads `Expense`
 * alone, and `statedTotal` below is never summed into spend.
 *
 * The consistency rule that keeps this honest: one purchase is one vendor-side
 * event, never a contract and never a card charge. Settlement is represented by
 * FinancialTransaction, so one Purchase may have installments, split tender,
 * shipment charges, and later refunds without changing its vendor identity.
 */

const purchaseFields = {
  vendorId: vendorShortcode,
  orderId: z
    .string()
    .nullable()
    .describe(
      'The vendor\'s own order/receipt id — Amazon "111-1234567-1234567", Home Depot "WN63446464", Tool Nirvana "#11325". Free text: every retailer formats these differently and validating them would only reject real data. Unique per vendor when present; null for the ~40% of purchases that never got one.',
    ),
  displayLabel: z
    .string()
    .nullable()
    .describe(
      "Optional human-entered context preserved from the original ledger, rendered parenthetically after the purchase identity — for example 11100722797 (pocket hole jig + bits).",
    ),
  date: plainDate.describe("The vendor order or receipt date"),
  statedTotal: wholeCentAmount
    .nullable()
    .describe(
      "What the purchase paperwork says the total was, in dollars. NEVER summed into spend — spend is SUM(expense.cost). Purely a reconciliation cue against the expenses below it, and a mismatch is often correct (a partial refund reduces an expense without changing the stated paperwork total).",
    ),
  notes: z.string().nullable(),
};

const purchaseCreateShape = {
  ...purchaseFields,
  orderId: z.string().nullable().default(null),
  displayLabel: z.string().nullable().optional(),
  date: plainDate,
  statedTotal: wholeCentAmount.nullable().default(null),
  notes: z.string().nullable().default(null),
  /**
   * Newly-uploaded document ids awaiting association. The
   * `PendingDocumentUpload` widget pushes the file to R2 first and hands back a
   * PENDING image id; it only becomes a real attachment when a save carries it
   * here. Without this an uploaded invoice sits unassociated and gets culled in
   * 24 hours.
   */
  pendingImageIds: z.array(z.uuid()).optional(),
};

export const purchaseCreateInput = z.object(purchaseCreateShape);
export type PurchaseCreateInput = z.infer<typeof purchaseCreateInput>;

/**
 * A partial update makes every create field optional. `removeImageIds` /
 * `imageOrder` are update-only — you can't reorder or detach a document on a
 * purchase that doesn't exist yet — so they come in through `extend`, exactly as
 * `productUpdateData` does.
 */
export const purchaseUpdateData = deriveUpdateData(purchaseCreateShape, {
  extend: {
    removeImageIds: z
      .array(z.uuid())
      .optional()
      .describe(
        "Document ids to detach. Detaching DELETES the stored file when nothing else references it — there is no restore, and the id will not resolve again.",
      ),
    imageOrder: z
      .array(z.uuid())
      .optional()
      .describe("existing document ids in display order"),
  },
});
export type PurchaseUpdateData = z.infer<typeof purchaseUpdateData>;
export const purchaseUpdateInput = z.object({
  id: purchaseShortcode,
  data: purchaseUpdateData,
});
export type PurchaseUpdateInput = z.infer<typeof purchaseUpdateInput>;

/** Mutually exclusive health buckets for the Expenses under one Purchase. */
export const purchaseExpenseStatus = z.enum(["empty", "unpriced", "priced"]);
export type PurchaseExpenseStatus = z.infer<typeof purchaseExpenseStatus>;

/**
 * The soft reconciliation verdict for a Purchase's stated total versus its Expenses.
 * `unknown` means there is no stated total to compare against.
 */
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
  ...auditDateFilterFields,
  search: z
    .string()
    .optional()
    .describe("Substring match on order id or human display label"),
  displayLabelSearch: z
    .string()
    .optional()
    .describe("Substring match on the human display label only"),
  vendorId: entityFilterList(vendorShortcode).optional(),
  ...purchaseRelatedFilterFields,
  orderId: oneOrMany(z.string()).optional(),
  /** `"none"` matches purchases with no order id — the ~40% the vendor never issued one for. */
  orderIdPresenceFilter: presenceFilter,
  /** `"none"` matches purchases with no `statedTotal` recorded yet. */
  statedTotalPresenceFilter: presenceFilter,
  /** Empty, partly unpriced, or fully priced Expense sets; several values OR. */
  expenseStatus: oneOrMany(purchaseExpenseStatus).optional(),
  /** Shared soft verdict over statedTotal versus SUM(expense.cost). */
  reconciliation: oneOrMany(purchaseReconciliation).optional(),
  financialReconciliation: z.enum(["mismatch"]).optional(),
  /** `"none"` matches purchases with no live invoice/receipt document. */
  documentPresenceFilter: presenceFilter,
  dataStatus: dataQualityStatus.optional(),
  dataGap: oneOrMany(dataCheck).optional(),
  /**
   * Inclusive bounds on SUM(expense.cost), in dollars. Bounds only apply to
   * Purchases with at least one priced Expense, so empty or unpriced-only Purchases do
   * not masquerade as zero-dollar credits.
   */
  expenseTotalMin: z.coerce.number().optional(),
  expenseTotalMax: z.coerce.number().optional(),
  dateFrom: plainDate
    .optional()
    .describe("Inclusive lower bound on purchase date"),
  dateTo: plainDate
    .optional()
    .describe("Inclusive upper bound on purchase date"),
};
export const purchaseFiltersSchema = z.object(purchaseFilterFields);
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;

export const purchaseSortableFields = [
  "orderId",
  "displayLabel",
  "date",
  "statedTotal",
  // Joined / rolled-up, resolved by correlated subqueries in repo/purchase.ts.
  "vendor",
  "expenseCount",
  "expenseTotal",
  "reconciliationGap",
  "documentCount",
  "createdAt",
  "updatedAt",
] as const;
export type PurchaseSortField = (typeof purchaseSortableFields)[number];

export const purchaseOut = z.object({
  id: purchaseShortcode,
  ...purchaseFields,
  /** Resolved through the join; null only if the vendor was soft-deleted. */
  vendorName: z.string().nullable(),
  /** The vendor's displayable logo for embedded purchase surfaces. */
  vendorLogo: imageUrlSummary.nullable(),
  /**
   * Link out to the vendor's own order page, derived at read time from
   * `vendor.orderUrlTemplate` + `orderId` (see `purchaseOrderUrl`). Read-only
   * and absent from the create/update shapes — nothing stores it, and null
   * simply means this order isn't linkable.
   */
  orderUrl: z.url().nullable(),
  expenseCount: z.number().int(),
  /** Live Expenses whose cost has not been recorded yet. */
  unpricedExpenseCount: z.number().int(),
  /**
   * `SUM(cost)` over this purchase's live expenses. THIS is the purchase's spend;
   * `statedTotal` is only what the paperwork claimed. They may legitimately
   * disagree — see the reconciliation note on `statedTotal`.
   */
  expenseTotal: money,
  /** Shared stated-total verdict, including posted-refund explanations. */
  reconciliation: purchaseReconciliation,
  /** Settlement evidence only; never participates in spend rollups. */
  financialReconciliation: financialReconciliationSummary,
  /** Live invoice/receipt documents filed against this purchase. */
  documentCount: z.number().int(),
  /**
   * The purchase's filed documents — the emailed PDF invoice, a photo of the paper
   * slip, or both, in display order.
   *
   * `contentType` is load-bearing, unlike the project analogue's summary shape:
   * `partitionEntityFiles` / `isDocumentFile` split PDFs from images on it, and
   * without it a PDF renders as a broken thumbnail instead of in the iframe
   * viewer.
   */
  images: z.array(
    z.object({
      id: z.string(),
      url: z.url(),
      filename: z.string(),
      contentType: z.string(),
      /**
       * The R2 object key. Nothing RENDERS it — it's here because it's part of an
       * image's identity, and because `PendingDocument` (the upload widget's row
       * type) requires it, which is what lets the document list offer a detach
       * affordance without a per-document round-trip back to `image.getByID`.
       */
      key: z.string(),
      documentKind: purchaseDocumentKind,
    }),
  ),
  dataQuality,
  ...timestampedFields,
});
export type PurchaseOut = z.infer<typeof purchaseOut>;

export const purchaseListResponse = createPaginatedResponseSchema(purchaseOut);
export type PurchaseListResponse = z.infer<typeof purchaseListResponse>;

export const reclassifyPurchaseDocumentInput = z.object({
  purchaseId: purchaseShortcode,
  imageId: z.uuid(),
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

/**
 * Compared in **cents**, not in floats.
 *
 * `Math.abs(100 - 99.99)` is `0.010000000000005116`, so a plain
 * `<= RECONCILIATION_TOLERANCE` made a nominal one-cent gap read `mismatch` at
 * `statedTotal: 100` and `match` at other magnitudes — the verdict depended on
 * where binary floating point happened to land, which is not something a
 * human-facing cue should do. Both operands are dollar amounts from
 * `double precision` columns, and the unit that matters is the cent, so rounding
 * to cents before comparing makes the boundary mean what it says.
 */
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

/**
 * Split one expense into parts against the same purchase — replaces the
 * `(combo, saw portion)` naming convention that encoded splits in 12 row names.
 * Each part keeps its own trade/costType/project/product.
 */
export const splitExpenseInput = z.object({
  expenseId: expenseShortcode,
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
        trade: tradeSchema,
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
    .min(2),
});
export type SplitExpenseInput = z.infer<typeof splitExpenseInput>;

/**
 * The reconciliation cue `splitExpense` itself deliberately does not compute —
 * see its doc comment in `repo/purchase.ts`. This exists so the MCP tool can
 * hand a caller the same cue the web dialog shows live as the operator types,
 * without either side back-computing or rejecting anything.
 *
 * Compared in **cents**, like `reconcilePurchase` above and for the same
 * reason: both operands are dollar amounts off `double precision` columns, and
 * a plain float subtraction makes the verdict depend on where binary floating
 * point happens to land rather than on the actual cent gap.
 */
export const splitExpenseDelta = (
  originalCost: number | null,
  partCosts: number[],
): { originalCost: number | null; partsSum: number; delta: number | null } => {
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
 * Merge purchases the backfill couldn't group — the 364 singletons with no order
 * id, which no key could have joined (`(vendor, date)` would have falsely merged
 * 71 rows across 31 groups). A user action, never a backfill guess.
 */
export const mergePurchasesInput = z.object({
  keepId: purchaseShortcode,
  mergeIds: z.array(purchaseShortcode).min(1),
});
export type MergePurchasesInput = z.infer<typeof mergePurchasesInput>;

// Purchase ⟷ Product links (PurchaseProduct)
//
// Which Products a Purchase bought — nothing else. This carries NO money and
// NO quantity: that stays on `expense` (all money lives on Expense;
// `statedTotal` above is never summed into spend). It exists because an
// installment/lump-sum Purchase's Expenses are `lineBasis: "allocation"` and
// can never carry a `productId` (see `./expense-line-kind`) — an allocation
// line splits one payment across trades/costTypes, it does not name a
// product — so this link is otherwise the only way to say "this lump-sum
// order was for these three tools." Mirrors `projectResource*` in
// `./project` (the analogous Project ⟷ Product link) as closely as possible.

export const purchaseProductsInput = z.object({
  purchaseId: purchaseShortcode,
});

export const productPurchasesInput = z.object({
  productId: productShortcode,
});

export const purchaseProductMutationInput = z.object({
  purchaseId: purchaseShortcode,
  productIds: z.array(productShortcode).min(1).max(100),
});

/** See `relationMutationOut` (`./common`) for what `changed` / `attached` /
 * `alreadySatisfied` mean — this family's edge is `PurchaseProduct`. */
export const purchaseProductMutationOut = relationMutationOut;
export type PurchaseProductMutationOut = z.infer<
  typeof purchaseProductMutationOut
>;

/**
 * How a purchase⟷product row came to exist.
 *
 * `"link"` is an explicit `PurchaseProduct` row — the sparse provenance edge
 * that exists for allocation-basis orders, whose Expenses can never carry a
 * `productId`. `"expense"` is derived: a live acquisition Expense on that
 * purchase names that product. That case is the overwhelmingly common one and
 * was invisible to these reads until 2026-08, which is the bug this enum was
 * introduced to fix. `"both"` is a pair carrying each edge.
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
  /**
   * Live `ProductComponent` edges where this product is the parent — non-zero
   * means it is a kit, and its row can expand to show what it contains.
   */
  componentCount: z.number().int().nonnegative(),
});
export type PurchaseProductOut = z.infer<typeof purchaseProductOut>;
export const purchaseProductsOut = z.array(purchaseProductOut);

/** The MCP envelope: same rows, `{items}` root. See `productComponentsMcpOut`
 * (`./product-components`) — an array root fails the SDK's own re-validation of
 * `structuredContent`, so it broke every `list_purchase_products` call. */
export const purchaseProductsMcpOut =
  createItemsResponseSchema(purchaseProductOut);

/** The transpose: one Product's row on another Purchase's link list. */
export const productPurchaseOut = z.object({
  purchaseId: purchaseShortcode,
  displayLabel: z.string().nullable(),
  date: plainDate,
  vendorName: z.string().nullable(),
  orderId: z.string().nullable(),
  source: purchaseProductSource,
  linkAttachedAt,
});
export type ProductPurchaseOut = z.infer<typeof productPurchaseOut>;
export const productPurchasesOut = z.array(productPurchaseOut);
