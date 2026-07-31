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
  unsafeProjectShortcode,
  unsafePurchaseShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import {
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "~/server/repo/database-helpers";

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
  date: string | null;
  costType: ExpenseOut["costType"];
  trade: ExpenseOut["trade"];
  url: string | null;
  notes: string | null;
  future: boolean;
  projectId: ProjectId | null;
  productId: ProductId | null;
  purchaseId: PurchaseId | null;
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; shortcode: string; deletedAt: Date | null } | null;
  product: { name: string; shortcode: string; deletedAt: Date | null } | null;
  purchase: {
    id: PurchaseId;
    shortcode: string;
    orderId: string | null;
    date: string | null;
    vendorId: VendorId;
    deletedAt: Date | null;
    vendor: { name: string; shortcode: string; deletedAt: Date | null } | null;
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
    costType: row.costType,
    trade: row.trade,
    url: row.url,
    notes: row.notes,
    future: row.future,
    projectId: toProjectShortcode(resolveLiveJoinShortcode(row.project)),
    projectName: resolveLiveJoinName(row.project),
    productId: toProductShortcode(resolveLiveJoinShortcode(row.product)),
    productName: resolveLiveJoinName(row.product),
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
    vendorId:
      purchaseRow?.vendor != null
        ? unsafeVendorShortcode(purchaseRow.vendor.shortcode)
        : null,
    vendor: purchaseRow ? resolveLiveJoinName(purchaseRow.vendor) : null,
    orderId: purchaseRow?.orderId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
