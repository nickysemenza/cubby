/**
 * Expense CRUD operations.
 *
 * Expense has no dependency edges and no rollups — a plain diff-audited
 * column update, so (unlike project/task) it fits `createEntityCrud` directly
 * instead of hand-rolling `update`.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { ImpactItem } from "@cubby/schemas/entity-integrity";
import type { ExpenseId, PurchaseId } from "@cubby/schemas/identifiers";
import type {
  ExpenseBulkCostTypeInput,
  ExpenseBulkMoveInput,
  ExpenseBulkTradeInput,
  ExpenseCreateInput,
  ExpenseOut,
  ExpenseUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { entityEmbedding, expense } from "~/server/db/schema";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { assertProjectLive } from "~/server/repo/project";
import {
  assertPurchaseLive,
  findOrCreatePurchase,
  foldChargeInto,
  renameChargeOrderId,
} from "~/server/repo/purchase";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";
import { dbExpenseToAPI, type ExpenseRow } from "./helpers";

/** `expenseUpdateData` has no standalone type export — derive it from the input. */
type ExpenseUpdateData = ExpenseUpdateInput["data"];

// The union, not `Database`: the factory's `update` runs on a transaction and
// reads the before-state through this. The return type is annotated explicitly
// because `unwrapDb` hands back `DrizzleClient | DrizzleTransaction` and the
// inferred `findFirst` result would union across the two relational clients —
// structurally identical, but a union TS then has to re-check at every use.
const fetchExpenseById = (
  db: Database | DrizzleTransaction,
  id: ExpenseId,
): Promise<ExpenseRow | undefined> =>
  unwrapDb(db).query.expense.findFirst({
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
 * `current` is the charge the row is already on, and passing it is what stops an
 * UPDATE leaking charges. Without it, re-writing the same `{vendor}` onto an
 * order-less row would mint a fresh charge every time (`orderId: null` can't
 * dedupe — see `findOrCreatePurchase`), re-point the row to it, and leave the
 * previous charge behind with no lines and possibly a `statedTotal` and documents
 * on it. Nothing sweeps up empty charges, so that leak would be permanent.
 *
 * There are **two** doors to that leak and both are closed here:
 *
 * 1. An unchanged `{vendor}` resubmit — short-circuited as a no-op below.
 * 2. **Correcting the order id** on a charge whose only line is this expense.
 *    Minting a new charge there would abandon the old one exactly as in (1); what
 *    the user means by fixing a typo'd order id on a single-line charge is *edit
 *    this charge*, so the charge is renamed IN PLACE and keeps its `statedTotal`
 *    and documents. If the charge has OTHER lines it is not renamed — the line is
 *    genuinely being reassigned to a different order, and the old charge keeps its
 *    remaining lines, so nothing is orphaned.
 *
 * The in-place rename can still collide with an existing charge for
 * `(vendor, newOrderId)` — the partial-unique index. `findOrCreatePurchase`
 * resolves that by returning the existing charge, and the now-empty old one is
 * folded away by the caller.
 */
const resolveCharge = async (
  tx: DrizzleTransaction,
  actor: ActorContext,
  data: { vendor?: string | null; orderId?: string | null },
  current?: {
    purchaseId: PurchaseId | null;
    vendorName: string | null;
    orderId: string | null;
    /** Live lines on the current charge, this expense included. */
    lineCount: number;
  },
): Promise<PurchaseId | null | undefined> => {
  if (data.vendor === undefined && data.orderId === undefined) return undefined;

  // An explicit null is "detach from the charge", and outranks everything else.
  if (data.vendor === null) return null;

  // ⚠️ Falling back to the row's CURRENT vendor is load-bearing, not defensive.
  // Both Order # inline editors save `data: { orderId }` and nothing else
  // (expenselist.tsx and projects/shared.tsx), which is the ONLY shape the UI ever
  // sends for an order-id correction. Reading only `data.vendor` here made that
  // write a silent no-op — it appeared to save and changed nothing — which broke
  // the central purchase-import workflow of reconciling an order id against a
  // charge. A row with no vendor anywhere still drops the order id below, because
  // an order id alone can't name a transaction.
  const vendorName = data.vendor?.trim() || current?.vendorName || undefined;
  if (!vendorName) return undefined;

  const requestedOrderId = data.orderId?.trim() || null;
  const sameVendor = current?.vendorName === vendorName;

  // Already on a charge that says exactly this? Then this write is a no-op, and
  // creating a second identical charge would be the bug, not the fix.
  if (
    current?.purchaseId &&
    sameVendor &&
    // An omitted `orderId` means "leave it alone", so it can't force a new charge.
    (data.orderId === undefined || current.orderId === requestedOrderId)
  ) {
    return undefined;
  }

  // Door 2: same vendor, order id genuinely changing, and this expense is the
  // charge's only line — rename the charge rather than abandoning it.
  if (
    current?.purchaseId &&
    sameVendor &&
    current.lineCount <= 1 &&
    data.orderId !== undefined
  ) {
    const renamed = await renameChargeOrderId(
      tx,
      current.purchaseId,
      requestedOrderId,
      actor,
    );
    if (renamed) return undefined;
    // Collided with an existing charge for this (vendor, orderId): fall through
    // and attach to that one, then fold the emptied charge below.
  }

  const vendorId = await findOrCreateVendor(tx, vendorName);
  const target = await findOrCreatePurchase(tx, {
    vendorId,
    orderId:
      data.orderId === undefined
        ? (current?.orderId ?? null)
        : requestedOrderId,
  });

  // Leaving its last line behind makes the old charge dead weight. Fold it into
  // the target so its documents and `statedTotal` survive rather than stranding.
  if (
    current?.purchaseId &&
    current.purchaseId !== target &&
    current.lineCount <= 1
  ) {
    await foldChargeInto(tx, current.purchaseId, target, actor);
  }

  return target;
};

/**
 * Single-row update. Wraps the factory's `update` so a `{vendor, orderId}` write
 * lands on `purchaseId` — the factory only knows how to set columns, and those
 * two aren't columns any more.
 *
 * An explicit `purchaseId` in the input short-circuits the name resolution
 * entirely (see the field's doc): an id is never a guess, so there's nothing to
 * resolve.
 *
 * ONE transaction covers all three phases — the `assertPurchaseLive` guard, the
 * charge resolution, and the factory's audited column write. That is a
 * correctness requirement, not a round-trip saving, and it's the same invariant
 * `createExpense` states below: `resolveCharge` can mint a vendor, mint a
 * charge, rename a charge in place, or fold one away, and the column write can
 * still fail afterwards (`updateLiveAndReturn` throws when the row was
 * concurrently soft-deleted). With separate boundaries those side-effects
 * committed and the failed write left behind an orphan vendor, an orphan charge,
 * or a charge folded away for no reason. Sharing the boundary also closes the
 * guard's TOCTOU window: a purchase soft-deleted between `assertPurchaseLive`
 * and the UPDATE can no longer be adopted.
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

  return withTransaction(db, async (tx) => {
    // `rest` can carry an explicit `purchaseId` that never passes through
    // `resolveCharge`, so validate it here or it goes in unchecked. Mutually
    // exclusive with the resolve path below (`needsResolve` requires
    // `data.purchaseId === undefined`).
    if (rest.purchaseId) await assertPurchaseLive(tx, rest.purchaseId);

    if (!needsResolve) return expenseCrud.update(tx, id, rest, actor);

    // The row's CURRENT charge, so an unchanged `{vendor}` write doesn't mint a
    // duplicate — see `resolveCharge`.
    const existing = await tx.query.expense.findFirst({
      where: and(eq(expense.id, id), notDeleted(expense)),
      columns: { purchaseId: true },
      with: {
        purchase: {
          columns: { id: true, orderId: true, deletedAt: true },
          with: { vendor: { columns: { name: true, deletedAt: true } } },
        },
      },
    });
    // A soft-deleted charge (or vendor) reads as absent here for the same reason
    // it does in `dbExpenseToAPI` — the row is effectively unattached, so a
    // vendor write should give it a live charge rather than reuse a dead one.
    const live =
      existing?.purchase?.deletedAt === null ? existing.purchase : undefined;

    // How many live lines the current charge has, which decides whether an
    // order-id correction renames the charge in place or reassigns this line to a
    // different one. Only asked when there IS a charge.
    //
    // Counted on `tx`, not on `db`: a read on the outer handle is a DIFFERENT
    // connection, so it can't see this transaction's own writes and — under the
    // per-request `pg.Pool` (max 5) — competes with it for a connection. The
    // decision this count drives then races the very rows it's counting.
    const lineCount = live
      ? ((
          await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(expense)
            .where(and(eq(expense.purchaseId, live.id), notDeleted(expense)))
        )[0]?.n ?? 0)
      : 0;

    const resolved = await resolveCharge(tx, actor, data, {
      purchaseId: live ? (existing?.purchaseId ?? null) : null,
      vendorName:
        live?.vendor && live.vendor.deletedAt === null
          ? live.vendor.name
          : null,
      orderId: live?.orderId ?? null,
      lineCount,
    });

    return expenseCrud.update(
      tx,
      id,
      { ...rest, ...(resolved === undefined ? {} : { purchaseId: resolved }) },
      actor,
    );
  });
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
    // A caller-supplied `purchaseId` skips `resolveCharge` entirely, so this is
    // the only place it gets checked for liveness — an FK proves the row exists,
    // not that it isn't tombstoned.
    if (data.purchaseId) await assertPurchaseLive(tx, data.purchaseId);
    const purchaseId =
      data.purchaseId ?? (await resolveCharge(tx, actor, data)) ?? null;

    const created = await insertWithShortcode(tx, "expense", {
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

/**
 * What `deleteExpenses` would do to the given expenses, without doing it.
 *
 * `expense` has zero incoming edges (`INCOMING_EDGES.expense` is `{}` — see
 * `entity-incoming-edges.ts`), so unlike every other preview in this feature
 * there is nothing to block or cascade: `blockers` and `changes` are always
 * empty. That doesn't make an expense delete a no-op — its one real
 * consequence, read straight off `deleteExpenses` above, is the same-transaction
 * `softDeleteEntityEmbeddingsTx` call that removes the row from search. The
 * count here is the SAME predicate that call uses (entityType match +
 * `inArray` + `notDeleted`), via `countByTarget`, so the two can't disagree.
 *
 * Unlike `inventory`, deleting an expense does NOT trigger a valuation
 * recompute: `needsValuationRecompute` in `services/mutation-side-effects.ts`
 * only fires for `inventory`/`product`/`location` events, and `expense`'s own
 * manifest entry there declares `onDelete: []`. Nothing downstream recomputes
 * off an expense delete.
 *
 * Advisory only. `deleteExpenses` still re-runs its own transaction; nothing
 * here is a lock or a permission.
 */
export const previewDeleteExpenses = async (
  db: Database,
  ids: ExpenseId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  if (ids.length === 0) return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = getDb(db);

  const sideEffects = present([
    impact({
      disposition: {
        code: "soft-delete-search-index",
        effect: "soft-delete",
        description:
          "The expense's search-index entry is soft-deleted in the same transaction as the delete.",
      },
      label: "search index entries",
      byTargetId: await countByTarget(
        dbClient,
        entityEmbedding,
        entityEmbedding.entityId,
        ids,
        { extraWhere: eq(entityEmbedding.entityType, "expense") },
      ),
    }),
  ]);

  return { blockers: [], changes: [], sideEffects };
};
