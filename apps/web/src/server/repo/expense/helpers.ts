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
 * linked `product`, and the `purchase` (charge) it belongs to — with that
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
    vendorId: VendorId;
    deletedAt: Date | null;
    vendor: { name: string; shortcode: string; deletedAt: Date | null } | null;
  } | null;
};

export const dbExpenseToAPI = (row: ExpenseRow): ExpenseOut => {
  // A soft-deleted charge reads as no charge at all — the same rule
  // `resolveLiveJoinName` applies to project/product below, so a deleted parent
  // renders blank rather than as live data.
  const charge = row.purchase?.deletedAt === null ? row.purchase : null;

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
    productId: row.productId,
    productName: resolveLiveJoinName(row.product),
    productShortcode: toProductShortcode(resolveLiveJoinShortcode(row.product)),
    // `vendor` and `orderId` are no longer columns on `Expense` — the charge
    // owns them, and they resolve through this join. Keeping the SAME output
    // keys is deliberate: it's what let the ledger's Vendor / Order # columns,
    // the MCP surface, and the purchase-import skill survive the split
    // untouched.
    //
    // `vendorId` is the charge's vendor FK, denormalized — always present on a
    // live charge regardless of whether the VENDOR itself was soft-deleted
    // (same "shortcode is a permanent tombstone" reasoning as
    // `purchaseOut.vendorId`); `vendor` (the display name) is separately
    // gated on the vendor's own liveness via `resolveLiveJoinName`.
    purchaseId: charge ? unsafePurchaseShortcode(charge.shortcode) : null,
    vendorId:
      charge?.vendor != null ? unsafeVendorShortcode(charge.vendor.shortcode) : null,
    vendor: charge ? resolveLiveJoinName(charge.vendor) : null,
    orderId: charge?.orderId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
