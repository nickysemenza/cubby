/**
 * Purchase CRUD operations.
 *
 * Purchase has no dependency edges and no rollups — a plain diff-audited
 * column update, so (unlike project/task) it fits `createEntityCrud` directly
 * instead of hand-rolling `update`.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { PurchaseId } from "@cubby/schemas/identifiers";
import type {
  PurchaseCreateInput,
  PurchaseOut,
  PurchaseUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import { purchase } from "~/server/db/schema";
import { logAuditEntries, logAuditEntry } from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { dbPurchaseToAPI } from "./helpers";

/** `purchaseUpdateData` has no standalone type export — derive it from the input. */
type PurchaseUpdateData = PurchaseUpdateInput["data"];

const fetchPurchaseById = (db: Database, id: PurchaseId) =>
  getDb(db).query.purchase.findFirst({
    where: and(eq(purchase.id, id), notDeleted(purchase)),
    ...relations.purchase.withProject,
  });

const purchaseCrud = createEntityCrud({
  table: purchase,
  entity: "purchase",
  fetchById: fetchPurchaseById,
  fromDB: (_db, row) => dbPurchaseToAPI(row),
  notFoundReason: "PURCHASE_NOT_FOUND",
  toUpdate: (data: PurchaseUpdateData) =>
    buildPartialUpdateValues({
      name: data.name,
      cost: data.cost,
      date: data.date,
      category: data.category,
      subcategory: data.subcategory,
      purchaser: data.purchaser,
      url: data.url,
      notes: data.notes,
      future: data.future,
      projectId: data.projectId,
    }),
  auditUpdateFields: [
    "name",
    "cost",
    "date",
    "category",
    "subcategory",
    "purchaser",
    "url",
    "notes",
    "future",
    "projectId",
  ],
});

export const getPurchaseByID = purchaseCrud.getByID;
export const updatePurchase = purchaseCrud.update;

export const createPurchase = async (
  db: Database,
  data: PurchaseCreateInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const id = await withTransaction(db, async (tx) => {
    const created = await insertAndReturn(tx, purchase, {
      name: data.name,
      cost: data.cost,
      date: data.date,
      category: data.category,
      subcategory: data.subcategory,
      purchaser: data.purchaser,
      url: data.url,
      notes: data.notes,
      future: data.future,
      projectId: data.projectId,
    });
    await logAuditEntry(tx, actor, {
      entityType: "purchase",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return getPurchaseByID(db, id);
};

export const deletePurchases = async (
  db: Database,
  ids: PurchaseId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, purchase, ids, "Purchase");

    const now = new Date();
    await tx
      .update(purchase)
      .set({ deletedAt: now })
      .where(and(inArray(purchase.id, ids), notDeleted(purchase)));

    // Removal-path invariant: every delete path cleans up its embeddings in-tx.
    await softDeleteEntityEmbeddingsTx(tx, "purchase", ids);

    await logAuditEntries(
      tx,
      actor,
      ids.map((id) => ({
        entityType: "purchase" as const,
        entityId: id,
        action: "delete" as const,
      })),
    );
  });
};
