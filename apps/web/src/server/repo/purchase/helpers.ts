import type { PurchaseOut } from "@cubby/schemas/project";
import { resolveLiveJoinName } from "~/server/repo/database-helpers";

/**
 * Shape of a `purchase` row loaded with its (nullable) parent `project` and
 * linked `product` names.
 */
type PurchaseRow = {
  id: PurchaseOut["id"];
  name: string;
  cost: number | null;
  date: string | null;
  costType: PurchaseOut["costType"];
  trade: PurchaseOut["trade"];
  url: string | null;
  notes: string | null;
  future: boolean;
  projectId: PurchaseOut["projectId"];
  productId: PurchaseOut["productId"];
  vendor: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; deletedAt: Date | null } | null;
  product: { name: string; deletedAt: Date | null } | null;
};

export const dbPurchaseToAPI = (row: PurchaseRow): PurchaseOut => ({
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
  vendor: row.vendor,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
