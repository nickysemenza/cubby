import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import {
  generatedPurchaseFieldSchemas,
  generatedPurchaseFilterFields,
} from "./generated/entity-field-schemas.purchase.gen";
import { auditDateFilterFields, uniqueBy } from "./base-entity";
import { relationMutationOut } from "./common";
import { dataCheck, dataQualityStatus } from "./data-quality";
import {
  expenseShortcode,
  imageShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "./identifiers";
import { expenseLineKindSchema } from "./expense-line-kind";
import { purchaseRelatedFilterFields } from "./related-view";
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
  plainDate,
  PRODUCT_QUANTITY_DESCRIPTION,
  tradeSchema,
} from "./project";
import { displayImagesField } from "./display-images";

export const splitExpenseOut = z.array(expenseOut);

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
  ...auditDateFilterFields,
  ...generatedPurchaseFilterFields,
  vendorId: entityFilterList(vendorShortcode).optional(),
  ...purchaseRelatedFilterFields,
  orderId: oneOrMany(z.string()).optional(),
  /** `"none"` matches purchases with no order id — the ~40% the vendor never issued one for. */
  orderIdPresenceFilter: presenceFilter,
  expenseStatus: oneOrMany(purchaseExpenseStatus).optional(),
  /** Shared soft verdict over statedTotal versus SUM(expense.cost). */
  reconciliation: oneOrMany(purchaseReconciliation).optional(),
  financialReconciliation: z.enum(["mismatch"]).optional(),
  documentPresenceFilter: presenceFilter,
  dataStatus: dataQualityStatus.optional(),
  dataGap: oneOrMany(dataCheck).optional(),
};
export const purchaseFiltersSchema = z.object(purchaseFilterFields);
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;

export type PurchaseSortField = GeneratedEntitySortField<"purchase">;

/**
 * The purchase read shape is exactly the declaration's read projection —
 * every computed field (vendor join, order URL, expense rollups,
 * reconciliation, documents) is declared there with its constraints.
 */
export const purchaseOut = z.object(generatedPurchaseFieldSchemas.read);
export type PurchaseOut = z.infer<typeof purchaseOut>;

export const purchaseListItemOut = purchaseOut.extend({
  displayImages: displayImagesField,
});
export type PurchaseListItemOut = z.infer<typeof purchaseListItemOut>;

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

export const purchaseProductMutationInput = z.object({
  purchaseId: purchaseShortcode,
  productIds: z.array(productShortcode).min(1).max(100),
});

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
  componentCount: z.number().int().nonnegative(),
});
export type PurchaseProductOut = z.infer<typeof purchaseProductOut>;
export const purchaseProductsOut = z.array(purchaseProductOut);

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
