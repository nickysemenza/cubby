import type {
  ExpenseId,
  ProductId,
  ProjectId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import {
  unsafeExpenseShortcode,
  unsafeProductShortcode,
  unsafeProjectId,
  unsafeProjectShortcode,
  unsafePurchaseShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";
import { FOOD_CATEGORY } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import type { DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  notDeleted,
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

/**
 * Reject a negative quantity on a positive-cost line.
 *
 * `Expense.productQuantity` is signed, but money direction wins: a positive
 * cost is an acquisition of `+|qty|` no matter what sign is stored, so a
 * negative value there says nothing and only corrupts the one aggregate that
 * sums the raw column — the derived unit price in `product/pricing.ts`.
 *
 * Deliberately NOT mirrored for `cost < 0`: 302 live rows store a *positive*
 * quantity on a negative-cost line (returns and refunds imported as written),
 * and the ledger reads those as `−|qty|`, so both signs are legal there.
 */
export const assertQuantitySignMatchesCost = (
  cost: number | null,
  productQuantity: number | null,
) => {
  if (
    cost !== null &&
    cost > 0 &&
    productQuantity !== null &&
    productQuantity < 0
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A positive-cost line is an acquisition; its quantity cannot be negative. Record an exit as a negative cost, or as a $0 line with a negative quantity.",
    );
  }
};

/**
 * Shape of an `expense` row loaded with its (nullable) parent `project`, its
 * linked `product`, and the vendor `purchase` event it belongs to — with that
 * charge's `vendor` in turn.
 */

/** Brand a resolved join shortcode, preserving null for an absent/deleted parent. */
const toProductShortcode = (code: string | null) =>
  code === null ? null : unsafeProductShortcode(code);

const toProjectShortcode = (code: string | null) =>
  code === null ? null : unsafeProjectShortcode(code);

export type ExpenseRow = {
  id: ExpenseId;
  shortcode: string;
  name: string;
  cost: number | null;
  date: string;
  lineKind: ExpenseOut["lineKind"];
  lineBasis: ExpenseOut["lineBasis"];
  costType: ExpenseOut["costType"];
  trade: ExpenseOut["trade"];
  url: string | null;
  notes: string | null;
  future: boolean;
  projectId: ProjectId | null;
  productId: ProductId | null;
  productQuantity: number | null;
  purchaseId: PurchaseId | null;
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; shortcode: string; deletedAt: Date | null } | null;
  product: { name: string; shortcode: string; deletedAt: Date | null } | null;
  purchase: {
    id: PurchaseId;
    shortcode: string;
    orderId: string | null;
    displayLabel: string | null;
    date: string;
    vendorId: VendorId;
    deletedAt: Date | null;
    vendor: {
      name: string;
      shortcode: string;
      orderUrlTemplate: string | null;
      deletedAt: Date | null;
    } | null;
  } | null;
};

export const dbExpenseToAPI = (row: ExpenseRow): ExpenseOut => {
  // A soft-deleted Purchase reads as no Purchase at all — the same rule
  // `resolveLiveJoinName` applies to project/product below, so a deleted parent
  // renders blank rather than as live data.
  const purchaseRow = row.purchase?.deletedAt === null ? row.purchase : null;

  return {
    id: unsafeExpenseShortcode(row.shortcode),
    name: row.name,
    cost: row.cost,
    date: row.date,
    lineKind: row.lineKind,
    lineBasis: row.lineBasis,
    costType: row.costType,
    trade: row.trade,
    url: row.url,
    notes: row.notes,
    future: row.future,
    projectId: toProjectShortcode(resolveLiveJoinShortcode(row.project)),
    projectName: resolveLiveJoinName(row.project),
    productId: toProductShortcode(resolveLiveJoinShortcode(row.product)),
    productName: resolveLiveJoinName(row.product),
    productQuantity: row.productQuantity,
    // `vendor` and `orderId` are no longer columns on `Expense` — the Purchase
    // owns them, and they resolve through this join. Keeping the SAME output
    // keys is deliberate: it's what let the ledger's Vendor / Order # columns,
    // the MCP surface, and the purchase-import skill survive the split
    // untouched.
    //
    // `vendorId` is the Purchase's vendor FK, denormalized — always present on a
    // live Purchase regardless of whether the VENDOR itself was soft-deleted
    // (same "shortcode is a permanent tombstone" reasoning as
    // `purchaseOut.vendorId`); `vendor` (the display name) is separately
    // gated on the vendor's own liveness via `resolveLiveJoinName`.
    purchaseId: purchaseRow
      ? unsafePurchaseShortcode(purchaseRow.shortcode)
      : null,
    purchaseDate: purchaseRow?.date ?? null,
    purchaseDisplayLabel: purchaseRow?.displayLabel ?? null,
    vendorId:
      purchaseRow?.vendor != null
        ? unsafeVendorShortcode(purchaseRow.vendor.shortcode)
        : null,
    vendor: purchaseRow ? resolveLiveJoinName(purchaseRow.vendor) : null,
    orderId: purchaseRow?.orderId ?? null,
    // Derived, never stored: the vendor's own order page for this order. Gated
    // on the vendor's liveness like `vendor` above — a soft-deleted vendor's
    // template shouldn't keep producing links.
    orderUrl:
      purchaseRow?.vendor?.deletedAt === null
        ? purchaseOrderUrl({
            orderUrlTemplate: purchaseRow.vendor.orderUrlTemplate,
            orderId: purchaseRow.orderId,
          })
        : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/**
 * The import-time triage default: a food line with no project belongs to
 * Household.
 *
 * This is an IMPORT-TIME default and nothing more. `updateExpense` and
 * `moveExpenses` deliberately do NOT call it — an update is an explicit
 * statement about one row the operator is looking at, and `moveExpenses` is
 * the bulk move-to-inbox undo. Re-defaulting in either would make "clear the
 * project on this food line" impossible, bouncing every clear straight back to
 * Household with no error and no audit diff to explain it. Automation triages,
 * humans override, an override is never re-triaged.
 *
 * Returns `null` when no Household project exists, so a database that has not
 * been backfilled (every existing test, any fresh dev DB) behaves exactly as it
 * did before. Absence degrades, it never throws.
 *
 * Scope is `category === 'food'` on purpose. The other backfilled cohort —
 * household/supplies repurchased three or more times — is a retrospective
 * aggregate over a product's history; evaluating it per-insert would cost a
 * grouped query on every create and would triage the third bottle of shampoo
 * while leaving the first two behind.
 */
export const resolveDefaultProjectId = async (
  tx: DrizzleTransaction,
  args: { projectId: ProjectId | null; productId: ProductId | null },
): Promise<ProjectId | null> => {
  // An explicitly chosen project always wins. Note `expenseCreateShape.projectId`
  // is `.nullable().default(null)`, so post-parse an omitted field and an
  // explicit null are indistinguishable — there is no "caller was silent" case
  // to honour, and pretending otherwise would buy a rule that never fires.
  if (args.projectId !== null || args.productId === null) return args.projectId;

  const linked = await tx.query.product.findFirst({
    where: and(eq(product.id, args.productId), notDeleted(product)),
    columns: { category: true },
  });
  if (linked?.category !== FOOD_CATEGORY) return null;

  const householdId = await resolveLiveShortcode(
    tx,
    HOUSEHOLD_PROJECT_SHORTCODE,
    "project",
  );
  return householdId ? unsafeProjectId(householdId) : null;
};
