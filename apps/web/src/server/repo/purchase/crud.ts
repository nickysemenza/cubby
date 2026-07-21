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
  PurchaseBulkMoveInput,
  PurchaseCreateInput,
  PurchaseOut,
  PurchaseUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import { purchase } from "~/server/db/schema";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
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
import { assertProjectLive } from "~/server/repo/project";
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
      costType: data.costType,
      trade: data.trade,
      url: data.url,
      notes: data.notes,
      future: data.future,
      projectId: data.projectId,
    }),
  auditUpdateFields: [
    "name",
    "cost",
    "date",
    "costType",
    "trade",
    "url",
    "notes",
    "future",
    "projectId",
  ],
});

export const getPurchaseByID = purchaseCrud.getByID;
export const updatePurchase = purchaseCrud.update;

/**
 * Batch by-id read for `movePurchases`'s bulk-write result — the same
 * row shape/join as `getPurchaseByID`, fetched with one `inArray` query
 * instead of N one-by-one calls. File-local — only consumed by
 * `movePurchases` below.
 */
const getPurchasesByIDs = async (
  db: Database,
  ids: PurchaseId[],
): Promise<PurchaseOut[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.purchase.findMany({
    where: and(inArray(purchase.id, ids), notDeleted(purchase)),
    ...relations.purchase.withProject,
  });
  return rows.map(dbPurchaseToAPI);
};

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
      costType: data.costType,
      trade: data.trade,
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

/**
 * Bulk "move to project" — a plain `projectId` column write over `ids`, one
 * transaction, one audit entry per row that actually changed. `projectId:
 * null` moves every listed purchase to the inbox. Unlike the single-row
 * `updatePurchase` there's no before/after row diff to lean on for
 * validation, so the target project's liveness is checked explicitly
 * (`assertProjectLive`) — the UI's project picker already filters to live
 * projects, but the tRPC API is callable directly.
 */
export const movePurchases = async (
  db: Database,
  input: PurchaseBulkMoveInput,
  actor: ActorContext,
): Promise<PurchaseOut[]> => {
  const { ids, projectId } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    if (projectId !== null) {
      await assertProjectLive(tx, projectId);
    }

    const before = await tx.query.purchase.findMany({
      where: and(inArray(purchase.id, ids), notDeleted(purchase)),
      columns: { id: true, projectId: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(purchase)
      .set({ projectId })
      .where(and(inArray(purchase.id, ids), notDeleted(purchase)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, projectId }, [
        "projectId",
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "purchase",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getPurchasesByIDs(db, updatedIds);
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
