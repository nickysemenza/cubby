import { z } from "zod";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import {
  expenseShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { costTypeSchema, plainDate, tradeSchema } from "./project";

/**
 * Purchase — ONE vendor transaction, and the home for charge-level truth: the
 * charge's stated total, its documents, its identity.
 *
 * `Vendor ──< Purchase ──< Expense`. A purchase is identified by its `orderId`
 * when the vendor issues one, and is otherwise one per expense row. **All money
 * lives on `expense`** — every `SUM(cost)` in the codebase reads `Expense`
 * alone, and `statedTotal` below is never summed into spend.
 *
 * The consistency rule that keeps this honest: one purchase = one vendor
 * transaction, never a contract. Masseria Calderisi's 11 progress payments are
 * **11 purchases**, not one — grouping them would make `Purchase` mean
 * "transaction" in one case and "contract" in another. The contract-level rollup
 * already exists and is `Project`.
 *
 * A purchase is therefore not guaranteed 1:1 with a *card charge* — Amazon bills
 * per shipment. That's the deferred `Payment` axis's job; pre-splitting on a
 * guess would trade real complexity today for a speculative feature.
 */

const purchaseFields = {
  vendorId: vendorShortcode,
  orderId: z
    .string()
    .nullable()
    .describe(
      'The vendor\'s own order/receipt id — Amazon "111-1234567-1234567", Home Depot "WN63446464", Tool Nirvana "#11325". Free text: every retailer formats these differently and validating them would only reject real data. Unique per vendor when present; null for the ~40% of charges that never got one.',
    ),
  date: plainDate.nullable().describe("The charge date"),
  statedTotal: z
    .number()
    .nullable()
    .describe(
      "What the charge itself says it was, in dollars. NEVER summed into spend — spend is SUM(expense.cost). Purely a reconciliation cue against the lines below it, and a mismatch is often correct (a partial refund reduces a line without changing what the charge stated).",
    ),
  notes: z.string().nullable(),
};

const purchaseCreateShape = {
  ...purchaseFields,
  orderId: z.string().nullable().default(null),
  date: plainDate.nullable().default(null),
  statedTotal: z.number().nullable().default(null),
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
 * charge that doesn't exist yet — so they come in through `extend`, exactly as
 * `productUpdateData` does.
 */
export const purchaseUpdateData = deriveUpdateData(purchaseCreateShape, {
  extend: {
    removeImageIds: z.array(z.uuid()).optional(),
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

/** Mutually-exclusive health buckets for the expense lines under one charge. */
export const purchaseLineStatus = z.enum(["empty", "unpriced", "priced"]);
export type PurchaseLineStatus = z.infer<typeof purchaseLineStatus>;

/**
 * The soft reconciliation verdict for a charge's stated total versus its lines.
 * `unknown` means there is no stated total to compare against.
 */
export const purchaseReconciliation = z.enum(["unknown", "match", "mismatch"]);
export type PurchaseReconciliation = z.infer<typeof purchaseReconciliation>;

export const purchaseFilterFields = {
  search: z.string().optional().describe("Substring match on order id"),
  vendorId: oneOrMany(vendorShortcode).optional(),
  orderId: oneOrMany(z.string()).optional(),
  /** `"none"` matches charges with no order id — the ~40% the vendor never issued one for. */
  orderIdPresenceFilter: presenceFilter,
  /** `"none"` matches charges with no `statedTotal` recorded yet. */
  statedTotalPresenceFilter: presenceFilter,
  /** Empty, partly-unpriced, or fully-priced line sets; several values OR. */
  lineStatus: oneOrMany(purchaseLineStatus).optional(),
  /** Shared soft verdict over statedTotal versus SUM(expense.cost). */
  reconciliation: oneOrMany(purchaseReconciliation).optional(),
  /** `"none"` matches charges with no live invoice/receipt document. */
  documentPresenceFilter: presenceFilter,
  /**
   * Inclusive bounds on SUM(expense.cost), in dollars. Bounds only apply to
   * charges with at least one priced line, so empty/unpriced-only charges do
   * not masquerade as zero-dollar credits.
   */
  expenseTotalMin: z.coerce.number().optional(),
  expenseTotalMax: z.coerce.number().optional(),
  dateFrom: plainDate
    .optional()
    .describe("Inclusive lower bound on charge date"),
  dateTo: plainDate.optional().describe("Inclusive upper bound on charge date"),
};
export const purchaseFiltersSchema = z.object(purchaseFilterFields);
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;

export const purchaseSortableFields = [
  "orderId",
  "date",
  "statedTotal",
  // Joined / rolled-up, resolved by correlated subqueries in repo/purchase.ts.
  "vendor",
  "expenseCount",
  "expenseTotal",
  "documentCount",
  "createdAt",
] as const;
export type PurchaseSortField = (typeof purchaseSortableFields)[number];

export const purchaseOut = z.object({
  id: purchaseShortcode,
  ...purchaseFields,
  /** Resolved through the join; null only if the vendor was soft-deleted. */
  vendorName: z.string().nullable(),
  expenseCount: z.number().int(),
  /** Live lines whose cost has not been recorded yet. */
  unpricedExpenseCount: z.number().int(),
  /**
   * `SUM(cost)` over this charge's live expenses. THIS is the charge's spend;
   * `statedTotal` is only what the paperwork claimed. They may legitimately
   * disagree — see the reconciliation note on `statedTotal`.
   */
  expenseTotal: z.number(),
  /** Live invoice/receipt documents filed against this charge. */
  documentCount: z.number().int(),
  /**
   * The charge's filed documents — the emailed PDF invoice, a photo of the paper
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
    }),
  ),
  ...timestampedFields,
});
export type PurchaseOut = z.infer<typeof purchaseOut>;

export const purchaseListResponse = createPaginatedResponseSchema(purchaseOut);
export type PurchaseListResponse = z.infer<typeof purchaseListResponse>;

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
}): PurchaseReconciliation => {
  if (p.statedTotal === null) return "unknown";
  const gapInCents = Math.abs(
    Math.round(p.statedTotal * 100) - Math.round(p.expenseTotal * 100),
  );
  return gapInCents <= Math.round(RECONCILIATION_TOLERANCE * 100)
    ? "match"
    : "mismatch";
};

/**
 * One invoice spanning trades — Flow Form Plumbing's $2,516 covering both
 * rough-in and fixtures. Explicitly **not** for payment schedules: those are
 * separate charges, so they are separate purchases.
 */
export const linkExpensesToPurchaseInput = z.object({
  purchaseId: purchaseShortcode,
  expenseIds: z.array(expenseShortcode).min(1),
});
export type LinkExpensesToPurchaseInput = z.infer<
  typeof linkExpensesToPurchaseInput
>;

/**
 * Split one expense into parts against the same charge — replaces the
 * `(combo, saw portion)` naming convention that encoded splits in 12 row names.
 * Each part keeps its own trade/costType/project/product.
 */
export const splitExpenseInput = z.object({
  expenseId: expenseShortcode,
  parts: z
    .array(
      z.object({
        name: z.string().min(1),
        cost: z.number(),
        costType: costTypeSchema,
        trade: tradeSchema,
        projectId: projectShortcode.nullable().default(null),
        productId: productShortcode.nullable().default(null),
      }),
    )
    .min(2),
});
export type SplitExpenseInput = z.infer<typeof splitExpenseInput>;

/**
 * Merge charges the backfill couldn't group — the 364 singletons with no order
 * id, which no key could have joined (`(vendor, date)` would have falsely merged
 * 71 rows across 31 groups). A user action, never a backfill guess.
 */
export const mergePurchasesInput = z.object({
  keepId: purchaseShortcode,
  mergeIds: z.array(purchaseShortcode).min(1),
});
export type MergePurchasesInput = z.infer<typeof mergePurchasesInput>;
