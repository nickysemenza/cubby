import type { PurchaseOut } from "@cubby/schemas/project";
import { resolveLiveJoinName } from "~/server/repo/database-helpers";

/** Shape of a `purchase` row loaded with its (nullable) parent `project` name. */
type PurchaseRow = {
  id: PurchaseOut["id"];
  name: string;
  cost: number | null;
  date: string | null;
  category: PurchaseOut["category"];
  subcategory: string | null;
  purchaser: PurchaseOut["purchaser"];
  url: string | null;
  notes: string | null;
  future: boolean;
  projectId: PurchaseOut["projectId"];
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; deletedAt: Date | null } | null;
};

export const dbPurchaseToAPI = (row: PurchaseRow): PurchaseOut => ({
  id: row.id,
  name: row.name,
  cost: row.cost,
  date: row.date,
  category: row.category,
  subcategory: row.subcategory,
  purchaser: row.purchaser,
  url: row.url,
  notes: row.notes,
  future: row.future,
  projectId: row.projectId,
  projectName: resolveLiveJoinName(row.project),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
