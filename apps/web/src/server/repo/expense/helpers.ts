import type { ExpenseOut } from "@cubby/schemas/project";
import { resolveLiveJoinName } from "~/server/repo/database-helpers";

/**
 * Shape of an `expense` row loaded with its (nullable) parent `project`, its
 * linked `product`, and the `purchase` (charge) it belongs to — with that
 * charge's `vendor` in turn.
 */
type ExpenseRow = {
  id: ExpenseOut["id"];
  name: string;
  cost: number | null;
  date: string | null;
  costType: ExpenseOut["costType"];
  trade: ExpenseOut["trade"];
  url: string | null;
  notes: string | null;
  future: boolean;
  projectId: ExpenseOut["projectId"];
  productId: ExpenseOut["productId"];
  purchaseId: ExpenseOut["purchaseId"];
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; deletedAt: Date | null } | null;
  product: { name: string; deletedAt: Date | null } | null;
  purchase: {
    id: NonNullable<ExpenseOut["purchaseId"]>;
    orderId: string | null;
    vendorId: NonNullable<ExpenseOut["vendorId"]>;
    deletedAt: Date | null;
    vendor: { name: string; deletedAt: Date | null } | null;
  } | null;
};

export const dbExpenseToAPI = (row: ExpenseRow): ExpenseOut => {
  // A soft-deleted charge reads as no charge at all — the same rule
  // `resolveLiveJoinName` applies to project/product below, so a deleted parent
  // renders blank rather than as live data.
  const charge = row.purchase?.deletedAt === null ? row.purchase : null;

  return {
    id: row.id,
    name: row.name,
    cost: row.cost,
    date: row.date,
    costType: row.costType,
    trade: row.trade,
    url: row.url,
    notes: row.notes,
    future: row.future,
    projectId: row.projectId,
    projectName: resolveLiveJoinName(row.project),
    productId: row.productId,
    productName: resolveLiveJoinName(row.product),
    // `vendor` and `orderId` are no longer columns on `Expense` — the charge
    // owns them, and they resolve through this join. Keeping the SAME output
    // keys is deliberate: it's what let the ledger's Vendor / Order # columns,
    // the MCP surface, and the purchase-import skill survive the split
    // untouched. `purchaseId`/`vendorId` are additive, for linking.
    purchaseId: charge?.id ?? null,
    vendorId: charge?.vendorId ?? null,
    vendor: charge ? resolveLiveJoinName(charge.vendor) : null,
    orderId: charge?.orderId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
