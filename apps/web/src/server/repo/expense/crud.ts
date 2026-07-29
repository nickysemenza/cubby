/**
 * Expense CRUD operations.
 *
 * Expense has no dependency edges and no rollups — a plain diff-audited
 * column update, so (unlike project/task) it fits `createEntityCrud` directly
 * instead of hand-rolling `update`.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { ExpenseId, PurchaseId } from "@cubby/schemas/identifiers";
import type {
  ExpenseBulkCostTypeInput,
  ExpenseBulkMoveInput,
  ExpenseBulkTradeInput,
  ExpenseCreateInput,
  ExpenseOut,
  ExpenseUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { expense } from "~/server/db/schema";
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
import { findOrCreatePurchase } from "~/server/repo/purchase";
import { findOrCreateVendor } from "~/server/repo/vendor";
import { dbExpenseToAPI } from "./helpers";

/** `expenseUpdateData` has no standalone type export — derive it from the input. */
type ExpenseUpdateData = ExpenseUpdateInput["data"];

const fetchExpenseById = (db: Database, id: ExpenseId) =>
  getDb(db).query.expense.findFirst({
    where: and(eq(expense.id, id), notDeleted(expense)),
    ...relations.expense.withProject,
  });

const expenseCrud = createEntityCrud({
  table: expense,
  entity: "expense",
  fetchById: fetchExpenseById,
  fromDB: (_db, row) => dbExpenseToAPI(row),
  notFoundReason: "EXPENSE_NOT_FOUND",
  toUpdate: (data: ExpenseUpdateData) =>
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
      productId: data.productId,
      purchaseId: data.purchaseId,
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
    "productId",
    // `purchaseId` is the audited column now; `vendor`/`orderId` are resolved
    // into it by `resolveCharge` and are no longer columns on this table.
    "purchaseId",
  ],
});

export const getExpenseByID = expenseCrud.getByID;

/**
 * Resolve the `{vendor, orderId}` a caller still passes by NAME into the charge
 * they describe, creating the vendor and/or the charge on first sight.
 *
 * This is the seam that makes the whole split invisible to callers:
 * `createExpense` and MCP `create_expense` accept exactly the same input they
 * accepted when `vendor` was a text column, and the purchase-import skill,
 * quick-add and the ledger's create dialog never learned about ids. Both
 * `findOrCreateVendor` and `findOrCreatePurchase` are race-free, and both run
 * inside the CALLER's transaction so a failed expense insert can't leave an
 * orphan vendor behind.
 *
 * Returns `undefined` when the caller said nothing about a vendor, which is
 * distinct from `null` (an explicit "detach this from its charge") — the
 * difference partial-update semantics turn on.
 *
 * A vendorless row with an order id gets NO charge: an order id alone can't name
 * a transaction (they're only unique per vendor), so writing one would create a
 * charge nobody can identify. The order id is dropped rather than half-recorded.
 *
 * `current` is the charge the row is already on, and passing it is what keeps an
 * UPDATE idempotent. Without it, re-writing the same `{vendor}` onto an
 * order-less row would mint a fresh charge every time (`orderId: null` can't
 * dedupe — see `findOrCreatePurchase`), re-point the row to it, and leave the
 * previous charge behind with no lines and possibly a `statedTotal` and documents
 * on it. Nothing sweeps up empty charges, so that leak would be permanent.
 */
const resolveCharge = async (
  tx: DrizzleTransaction,
  data: { vendor?: string | null; orderId?: string | null },
  current?: {
    purchaseId: PurchaseId | null;
    vendorName: string | null;
    orderId: string | null;
  },
): Promise<PurchaseId | null | undefined> => {
  if (data.vendor === undefined && data.orderId === undefined) return undefined;

  const vendorName = data.vendor?.trim();
  if (!vendorName) return data.vendor === null ? null : undefined;

  // Already on a charge that says exactly this? Then this write is a no-op, and
  // creating a second identical charge would be the bug, not the fix.
  const requestedOrderId = data.orderId?.trim() || null;
  if (
    current?.purchaseId &&
    current.vendorName === vendorName &&
    // An omitted `orderId` means "leave it alone", so it can't force a new charge.
    (data.orderId === undefined || current.orderId === requestedOrderId)
  ) {
    return undefined;
  }

  const vendorId = await findOrCreateVendor(tx, vendorName);
  return findOrCreatePurchase(tx, {
    vendorId,
    orderId:
      data.orderId === undefined
        ? (current?.orderId ?? null)
        : requestedOrderId,
  });
};

/**
 * Single-row update. Wraps the factory's `update` so a `{vendor, orderId}` write
 * lands on `purchaseId` — the factory only knows how to set columns, and those
 * two aren't columns any more.
 *
 * An explicit `purchaseId` in the input short-circuits the name resolution
 * entirely (see the field's doc): an id is never a guess, so there's nothing to
 * resolve.
 */
export const updateExpense = async (
  db: Database,
  id: ExpenseId,
  data: ExpenseUpdateData,
  actor: ActorContext,
): Promise<ExpenseOut> => {
  const { vendor: _vendor, orderId: _orderId, ...rest } = data;

  const needsResolve =
    data.purchaseId === undefined &&
    (data.vendor !== undefined || data.orderId !== undefined);

  if (!needsResolve) {
    return expenseCrud.update(db, id, rest, actor);
  }

  // Resolving the charge is its own transaction, then the factory's audited
  // column write is another. Splitting them is deliberate: the factory owns the
  // before/after diff and its own transaction boundary, and re-implementing that
  // here to save one round-trip would fork the audit path for a single field.
  const resolved = await withTransaction(db, async (tx) => {
    // The row's CURRENT charge, so an unchanged `{vendor}` write doesn't mint a
    // duplicate — see `resolveCharge`.
    const existing = await tx.query.expense.findFirst({
      where: and(eq(expense.id, id), notDeleted(expense)),
      columns: { purchaseId: true },
      with: {
        purchase: {
          columns: { orderId: true, deletedAt: true },
          with: { vendor: { columns: { name: true, deletedAt: true } } },
        },
      },
    });
    // A soft-deleted charge (or vendor) reads as absent here for the same reason
    // it does in `dbExpenseToAPI` — the row is effectively unattached, so a
    // vendor write should give it a live charge rather than reuse a dead one.
    const live =
      existing?.purchase?.deletedAt === null ? existing.purchase : undefined;
    return resolveCharge(tx, data, {
      purchaseId: live ? (existing?.purchaseId ?? null) : null,
      vendorName:
        live?.vendor && live.vendor.deletedAt === null
          ? live.vendor.name
          : null,
      orderId: live?.orderId ?? null,
    });
  });

  return expenseCrud.update(
    db,
    id,
    { ...rest, ...(resolved === undefined ? {} : { purchaseId: resolved }) },
    actor,
  );
};

/**
 * Batch by-id read for `moveExpenses`'s bulk-write result — the same
 * row shape/join as `getExpenseByID`, fetched with one `inArray` query
 * instead of N one-by-one calls. File-local — only consumed by
 * `moveExpenses` below.
 */
const getExpensesByIDs = async (
  db: Database,
  ids: ExpenseId[],
): Promise<ExpenseOut[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.expense.findMany({
    where: and(inArray(expense.id, ids), notDeleted(expense)),
    ...relations.expense.withProject,
  });
  return rows.map(dbExpenseToAPI);
};

export const createExpense = async (
  db: Database,
  data: ExpenseCreateInput,
  actor: ActorContext,
): Promise<ExpenseOut> => {
  const id = await withTransaction(db, async (tx) => {
    // Same transaction as the insert: a vendor or charge created here must not
    // outlive a failed expense write.
    const purchaseId =
      data.purchaseId ?? (await resolveCharge(tx, data)) ?? null;

    const created = await insertAndReturn(tx, expense, {
      name: data.name,
      cost: data.cost,
      date: data.date,
      costType: data.costType,
      trade: data.trade,
      url: data.url,
      notes: data.notes,
      future: data.future,
      projectId: data.projectId,
      productId: data.productId,
      purchaseId,
    });
    await logAuditEntry(tx, actor, {
      entityType: "expense",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return getExpenseByID(db, id);
};

/**
 * Bulk "move to project" — a plain `projectId` column write over `ids`, one
 * transaction, one audit entry per row that actually changed. `projectId:
 * null` moves every listed expense to the inbox. Unlike the single-row
 * `updateExpense` there's no before/after row diff to lean on for
 * validation, so the target project's liveness is checked explicitly
 * (`assertProjectLive`) — the UI's project picker already filters to live
 * projects, but the tRPC API is callable directly.
 */
export const moveExpenses = async (
  db: Database,
  input: ExpenseBulkMoveInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const { ids, projectId } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    if (projectId !== null) {
      await assertProjectLive(tx, projectId);
    }

    const before = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
      columns: { id: true, projectId: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(expense)
      .set({ projectId })
      .where(and(inArray(expense.id, ids), notDeleted(expense)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, projectId }, [
        "projectId",
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "expense",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getExpensesByIDs(db, updatedIds);
};

/**
 * Bulk trade write — a plain audited `trade` column write over `ids`,
 * mirroring `moveExpenses` minus the project-live assert (trade is a free
 * enum, no FK). One wave-wide side-effect dispatch happens in the router.
 */
export const setExpensesTrade = async (
  db: Database,
  input: ExpenseBulkTradeInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const { ids, trade } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const before = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
      columns: { id: true, trade: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(expense)
      .set({ trade })
      .where(and(inArray(expense.id, ids), notDeleted(expense)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, trade }, ["trade"]);
      if (changes) {
        auditEntries.push({
          entityType: "expense",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getExpensesByIDs(db, updatedIds);
};

/** Bulk cost-type write — same shape as {@link setExpensesTrade}. */
export const setExpensesCostType = async (
  db: Database,
  input: ExpenseBulkCostTypeInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const { ids, costType } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const before = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
      columns: { id: true, costType: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(expense)
      .set({ costType })
      .where(and(inArray(expense.id, ids), notDeleted(expense)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, costType }, [
        "costType",
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "expense",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getExpensesByIDs(db, updatedIds);
};

export const deleteExpenses = async (
  db: Database,
  ids: ExpenseId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, expense, ids, "Expense");

    const now = new Date();
    await tx
      .update(expense)
      .set({ deletedAt: now })
      .where(and(inArray(expense.id, ids), notDeleted(expense)));

    // Removal-path invariant: every delete path cleans up its embeddings in-tx.
    await softDeleteEntityEmbeddingsTx(tx, "expense", ids);

    await logAuditEntries(
      tx,
      actor,
      ids.map((id) => ({
        entityType: "expense" as const,
        entityId: id,
        action: "delete" as const,
      })),
    );
  });
};
