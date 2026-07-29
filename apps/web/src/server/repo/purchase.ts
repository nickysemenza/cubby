/**
 * Purchase repository — ONE vendor transaction per row.
 *
 * `Vendor ──< Purchase ──< Expense`. See packages/schemas/src/purchase.ts for
 * the domain doc: why 11 progress payments are 11 purchases and not one, why
 * `statedTotal` is never spend, and why there is deliberately no
 * `splitPurchase`.
 *
 * The partial-unique `(vendorId, orderId) WHERE orderId IS NOT NULL AND live`
 * index is the load-bearing constraint in this file. It is what makes
 * `findOrCreatePurchase` unambiguous on the import hot path (one order can only
 * ever be one charge, so there's no "which charge?" branch), and it is what
 * `mergePurchases` has to defend against — two charges both carrying the same
 * non-null order id can't both survive a merge.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ExpenseId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { ExpenseOut } from "@cubby/schemas/project";
import type {
  LinkExpensesToPurchaseInput,
  MergePurchasesInput,
  PurchaseCreateInput,
  PurchaseFilters,
  PurchaseOut,
  PurchaseUpdateInput,
  SplitExpenseInput,
} from "@cubby/schemas/purchase";
import { purchaseSortableFields } from "@cubby/schemas/purchase";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { expense, image, purchase, purchaseImage } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  applyImageOrder,
  associatePendingImages,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  countWhere,
  eqAny,
  findOrCreate,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  nextImageSortOrder,
  notDeleted,
  presenceCondition,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { dbExpenseToAPI } from "~/server/repo/expense/helpers";

/**
 * A charge's line count and line total, as correlated scalar subqueries.
 *
 * `expenseTotal` is `SUM(expense.cost)` — the charge's actual spend. It is
 * deliberately NOT `statedTotal`, and nothing in this file ever sums
 * `statedTotal` into anything: see the reconciliation note in the schema. A
 * charge with no lines totals 0, not null, so the reconciliation cue reads
 * "stated $431.24, lines $0" rather than going blank.
 *
 * ⚠️ **`sql.raw` with hand-qualified identifiers, NOT interpolated Drizzle
 * columns.** For a single-table `select().from(x)`, Drizzle's `buildSelection`
 * rewrites every top-level `PgColumn` chunk inside a `sql` select field to a
 * BARE identifier, stripping the table prefix — so
 * `` sql`… WHERE ${expense.purchaseId} = ${purchase.id}` `` emits
 * `WHERE "purchaseId" = "id"`, which silently self-joins `Expense` and returns 0
 * for every row. Nested SQL (`notDeleted(t)`, `eq()`) is not recursed into and
 * survives, and `orderBy` is not a select field at all — so the SAME expression
 * sorts correctly while the displayed value is wrong, which is what makes this
 * so easy to miss. Aliasing the inner table (`e`, `v`) and spelling the outer
 * reference as `"Purchase"."…"` sidesteps the rewrite entirely: `sql.raw` has no
 * column chunks to strip. Same house pattern as `resolveExpenseSort` and
 * `repo/search.ts`.
 *
 * The outer reference must stay FULLY qualified. A bare `"id"` would bind to the
 * aliased inner table (which also has an `id`), not to the outer query.
 */
const correlated = <T>(fragment: string): SQL<T> =>
  sql<T>`${sql.raw(fragment)}`;

const purchaseExpenseCount = correlated<number>(
  `(SELECT count(*)::int FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL)`,
);

const purchaseExpenseTotal = correlated<number>(
  `(SELECT COALESCE(sum(e."cost"), 0)::double precision FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL)`,
);

const purchaseVendorName = correlated<string | null>(
  `(SELECT v."name" FROM "Vendor" v
     WHERE v."id" = "Purchase"."vendorId" AND v."deletedAt" IS NULL)`,
);

const purchaseColumns = {
  id: purchase.id,
  vendorId: purchase.vendorId,
  orderId: purchase.orderId,
  date: purchase.date,
  statedTotal: purchase.statedTotal,
  notes: purchase.notes,
  createdAt: purchase.createdAt,
  updatedAt: purchase.updatedAt,
  vendorName: purchaseVendorName,
  expenseCount: purchaseExpenseCount,
  expenseTotal: purchaseExpenseTotal,
} as const;

type PurchaseRow = {
  id: PurchaseId;
  vendorId: VendorId;
  orderId: string | null;
  date: string | null;
  statedTotal: number | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  vendorName: string | null;
  expenseCount: number;
  expenseTotal: number;
};

const dbPurchaseToAPI = (
  row: PurchaseRow,
  images: PurchaseOut["images"] = [],
): PurchaseOut => ({
  id: row.id,
  vendorId: row.vendorId,
  orderId: row.orderId,
  date: row.date,
  statedTotal: row.statedTotal,
  notes: row.notes,
  vendorName: row.vendorName,
  expenseCount: Number(row.expenseCount),
  expenseTotal: Number(row.expenseTotal),
  images,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * A charge's filed documents, in display order.
 *
 * Deliberately NOT loaded by `purchaseList`: the roster shows a document COUNT at
 * most, and a per-row join for files nobody renders is the kind of thing that
 * makes a list page slow for free. The detail read pays for it.
 */
const loadPurchaseImages = async (
  db: Database | DrizzleTransaction,
  id: PurchaseId,
): Promise<PurchaseOut["images"]> => {
  const rows = await unwrapDb(db)
    .select({
      id: image.id,
      url: image.url,
      filename: image.filename,
      contentType: image.contentType,
      key: image.key,
    })
    .from(purchaseImage)
    .innerJoin(image, eq(purchaseImage.imageId, image.id))
    .where(
      and(
        eq(purchaseImage.purchaseId, id),
        notDeleted(purchaseImage),
        notDeleted(image),
      ),
    )
    .orderBy(asc(purchaseImage.sortOrder), asc(purchaseImage.createdAt));
  return rows;
};

/**
 * Add newly-uploaded documents, remove requested ones, and apply an explicit
 * display order. Mirrors `syncProductImages` (repo/product/update-helpers.ts)
 * exactly, including applying the order BEFORE the append so new documents always
 * land after the reordered existing set.
 */
const syncPurchaseImages = async (
  tx: DrizzleTransaction,
  id: PurchaseId,
  pendingImageIds: string[] | undefined,
  removeImageIds: string[] | undefined,
  imageOrder: string[] | undefined,
): Promise<void> => {
  if (imageOrder && imageOrder.length > 0) {
    await applyImageOrder(
      tx,
      purchaseImage,
      purchaseImage.purchaseId,
      id,
      imageOrder,
    );
  }

  if (removeImageIds && removeImageIds.length > 0) {
    await tx
      .delete(purchaseImage)
      .where(
        and(
          eq(purchaseImage.purchaseId, id),
          inArray(purchaseImage.imageId, removeImageIds),
        ),
      );
  }

  if (pendingImageIds && pendingImageIds.length > 0) {
    const startSortOrder = await nextImageSortOrder(
      tx,
      purchaseImage,
      purchaseImage.purchaseId,
      id,
    );
    await associatePendingImages(
      tx,
      purchaseImage,
      "purchaseId",
      id,
      pendingImageIds,
      startSortOrder,
    );
  }
};

const buildPurchaseWhereClause = (filters: PurchaseFilters) =>
  buildSearchConditions(
    purchase,
    [{ column: purchase.orderId, term: filters.search }],
    [
      eqAny(purchase.vendorId, filters.vendorId),
      eqAny(purchase.orderId, filters.orderId),
      presenceCondition(purchase.orderId, filters.orderIdPresenceFilter),
      presenceCondition(
        purchase.statedTotal,
        filters.statedTotalPresenceFilter,
      ),
      filters.dateFrom
        ? sql`${purchase.date} >= ${filters.dateFrom}`
        : undefined,
      filters.dateTo ? sql`${purchase.date} <= ${filters.dateTo}` : undefined,
    ],
  );

/** Sorts over the joined vendor name and the two rollups — none are columns. */
const resolvePurchaseSort = (sort: SortParams) => {
  const dir = sort.direction === "asc" ? asc : desc;
  if (sort.orderBy === "vendor") return [dir(purchaseVendorName)];
  if (sort.orderBy === "expenseCount") return [dir(purchaseExpenseCount)];
  if (sort.orderBy === "expenseTotal") return [dir(purchaseExpenseTotal)];
  return null;
};

export const purchaseList = async (
  db: Database,
  filters: PurchaseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: PurchaseOut[]; count: number }> => {
  const whereClause = buildPurchaseWhereClause(filters);
  const { take, skip } = buildTakeSkip(pagination);

  const rows = await getDb(db)
    .select(purchaseColumns)
    .from(purchase)
    .where(whereClause)
    .orderBy(
      ...buildOrderBy(purchase, sorts, [...purchaseSortableFields], {
        resolve: resolvePurchaseSort,
      }),
    )
    .limit(take)
    .offset(skip);

  const count = await countWhere(db, purchase, whereClause);

  return { data: rows.map((row) => dbPurchaseToAPI(row)), count };
};

export const getPurchaseByID = async (
  db: Database,
  id: PurchaseId,
): Promise<PurchaseOut> => {
  const [row] = await getDb(db)
    .select(purchaseColumns)
    .from(purchase)
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .limit(1);
  if (!row) {
    throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${id}`);
  }
  return dbPurchaseToAPI(row, await loadPurchaseImages(db, id));
};

/**
 * The lines of one charge — the "this charge" section on an expense detail page
 * and the expense list on a purchase detail page.
 *
 * Replaces `getExpenseOrderSiblings`, which had to reconstruct the group by
 * matching `(vendor, orderId)` across rows and needed a Problems detector to
 * catch rows of one order disagreeing on vendor. It's now the parent link.
 *
 * Deliberately NOT extended to "other charges sharing this order id": an order
 * id is only unique WITHIN a vendor — a short one like Tool Nirvana's "#11325"
 * genuinely collides with other retailers — and the partial-unique index means
 * a same-vendor collision can't exist. Grouping across vendors would merge two
 * unrelated transactions, which is exactly what the old two-column key existed
 * to prevent.
 */
export const getPurchaseExpenses = async (
  db: Database,
  id: PurchaseId,
): Promise<ExpenseOut[]> => {
  const rows = await getDb(db).query.expense.findMany({
    where: and(eq(expense.purchaseId, id), notDeleted(expense)),
    orderBy: [asc(expense.date), asc(expense.name)],
    ...relations.expense.withProject,
  });
  return rows.map(dbExpenseToAPI);
};

/**
 * The import upsert: resolve `(vendorId, orderId)` to a charge, creating it on
 * first sight.
 *
 * Unambiguous by construction thanks to the partial-unique index — one order is
 * one charge, so there is never a "which of these charges did you mean?" branch
 * here. That is the whole reason the index is partial-unique rather than a plain
 * index.
 *
 * **`orderId: null` always creates a new charge.** It cannot do otherwise and
 * must not try: `(vendorId, null)` is not unique, and grouping by
 * `(vendor, date)` instead would have falsely merged 71 real ledger rows across
 * 31 groups. Two separate progress payments to one contractor on one day are two
 * charges. Merging near-duplicates is `mergePurchases`, a user action — never a
 * guess made on the write path.
 *
 * Races on the `orderId IS NOT NULL` path are handled by `findOrCreate`
 * (`ON CONFLICT DO NOTHING` + re-select), so two concurrent imports of the same
 * order produce exactly one charge.
 */
export const findOrCreatePurchase = async (
  db: Database | DrizzleTransaction,
  input: { vendorId: VendorId; orderId?: string | null; date?: string | null },
): Promise<PurchaseId> => {
  const orderId = input.orderId?.trim() || null;

  if (orderId === null) {
    const created = await insertAndReturn(db, purchase, {
      vendorId: input.vendorId,
      orderId: null,
      date: input.date ?? null,
    });
    return created.id;
  }

  const { row } = await findOrCreate(db, purchase, {
    // Must match the partial-unique index exactly — it's how `findOrCreate`
    // re-finds the winner when it loses the insert race.
    where: and(
      eq(purchase.vendorId, input.vendorId),
      eq(purchase.orderId, orderId),
      notDeleted(purchase),
    ),
    values: {
      vendorId: input.vendorId,
      orderId,
      date: input.date ?? null,
    },
  });
  return row.id;
};

export const createPurchase = async (
  db: Database,
  data: PurchaseCreateInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const id = await withTransaction(db, async (tx) => {
    const created = await insertAndReturn(tx, purchase, {
      vendorId: data.vendorId,
      orderId: data.orderId?.trim() || null,
      date: data.date,
      statedTotal: data.statedTotal,
      notes: data.notes,
    });
    // Same transaction as the insert: a document uploaded alongside a new charge
    // must not be left PENDING (and culled in 24h) if the insert fails.
    // `removeImageIds`/`imageOrder` are update-only — there is nothing to remove
    // or reorder on a charge that didn't exist a statement ago.
    await syncPurchaseImages(
      tx,
      created.id,
      data.pendingImageIds,
      undefined,
      undefined,
    );
    await logAuditEntry(tx, actor, {
      entityType: "purchase",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return getPurchaseByID(db, id);
};

const PURCHASE_AUDIT_FIELDS = [
  "vendorId",
  "orderId",
  "date",
  "statedTotal",
  "notes",
] as const;

export const updatePurchase = async (
  db: Database,
  input: PurchaseUpdateInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const { id, data } = input;

  await withTransaction(db, async (tx) => {
    const before = await tx.query.purchase.findFirst({
      where: and(eq(purchase.id, id), notDeleted(purchase)),
    });
    if (!before) {
      throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${id}`);
    }

    await syncPurchaseImages(
      tx,
      id,
      data.pendingImageIds,
      data.removeImageIds,
      data.imageOrder,
    );

    const after = await updateLiveAndReturn(
      tx,
      purchase,
      buildPartialUpdateValues({
        vendorId: data.vendorId,
        orderId:
          data.orderId === undefined ? undefined : data.orderId?.trim() || null,
        date: data.date,
        statedTotal: data.statedTotal,
        notes: data.notes,
      }),
      id,
    );

    const changes = computeChanges(before, after, [...PURCHASE_AUDIT_FIELDS]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "purchase",
        entityId: id,
        action: "update",
        changes,
      });
    }
  });

  return getPurchaseByID(db, id);
};

/**
 * Attach existing expenses to a charge — one invoice spanning trades (Flow Form
 * Plumbing's $2,516 covering rough-in *and* fixtures).
 *
 * Explicitly NOT for payment schedules: those are separate charges, so they stay
 * separate purchases. Works for expenses with no `orderId`, which is the
 * contractor case this whole model exists to serve.
 */
export const linkExpensesToPurchase = async (
  db: Database,
  input: LinkExpensesToPurchaseInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const { purchaseId, expenseIds } = input;

  await withTransaction(db, async (tx) => {
    const target = await tx.query.purchase.findFirst({
      where: and(eq(purchase.id, purchaseId), notDeleted(purchase)),
      columns: { id: true },
    });
    if (!target) {
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        `Purchase not found: ${purchaseId}`,
      );
    }

    const before = await tx.query.expense.findMany({
      where: and(inArray(expense.id, expenseIds), notDeleted(expense)),
      columns: { id: true, purchaseId: true },
    });
    if (before.length === 0) return;

    await tx
      .update(expense)
      .set({ purchaseId })
      .where(and(inArray(expense.id, expenseIds), notDeleted(expense)));

    await logAuditEntries(
      tx,
      actor,
      before.flatMap((row) => {
        const changes = computeChanges(row, { id: row.id, purchaseId }, [
          "purchaseId",
        ]);
        return changes
          ? [
              {
                entityType: "expense" as const,
                entityId: row.id,
                action: "update" as const,
                changes,
              },
            ]
          : [];
      }),
    );
  });

  return getPurchaseByID(db, purchaseId);
};

/**
 * Split one expense into parts against the same charge, in one transaction.
 *
 * Replaces the `(combo, saw portion)` naming convention that encoded splits in
 * 12 row names. Each part keeps its own trade/costType/project/product — that's
 * the point: a combo-kit purchase is one charge whose saw half is `tools` and
 * whose blade half is `materials`.
 *
 * `statedTotal` is seeded from the original cost when the charge doesn't have one
 * yet, so the parts have something to reconcile against. A deliberately
 * mismatched sum is **displayed, never rejected** — nothing here validates that
 * the parts add up, and nothing back-computes a cost.
 */
export const splitExpense = async (
  db: Database,
  input: SplitExpenseInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const { expenseId, parts } = input;

  const createdIds = await withTransaction(db, async (tx) => {
    const original = await tx.query.expense.findFirst({
      where: and(eq(expense.id, expenseId), notDeleted(expense)),
    });
    if (!original) {
      throw createAppError(
        "EXPENSE_NOT_FOUND",
        `Expense not found: ${expenseId}`,
      );
    }

    // Ensure the row HAS a charge before splitting: parts of one purchase must
    // share one parent, and a vendorless row has none yet. Nothing to invent a
    // vendor from, so this is the one case a split can't proceed.
    const chargeId = original.purchaseId;
    if (!chargeId) {
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        `Cannot split an expense with no charge attached (${expenseId}) — record its vendor first.`,
      );
    }

    if (original.cost !== null) {
      await tx
        .update(purchase)
        .set({ statedTotal: original.cost })
        .where(
          and(
            eq(purchase.id, chargeId),
            isNull(purchase.statedTotal),
            notDeleted(purchase),
          ),
        );
    }

    const inserted: ExpenseId[] = [];
    for (const part of parts) {
      const row = await insertAndReturn(tx, expense, {
        name: part.name,
        cost: part.cost,
        date: original.date,
        costType: part.costType,
        trade: part.trade,
        url: original.url,
        notes: null,
        future: original.future,
        projectId: part.projectId,
        productId: part.productId,
        purchaseId: chargeId,
      });
      inserted.push(row.id);
    }

    await tx
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(eq(expense.id, expenseId));

    await logAuditEntries(tx, actor, [
      ...inserted.map((id) => ({
        entityType: "expense" as const,
        entityId: id,
        action: "create" as const,
      })),
      {
        entityType: "expense" as const,
        entityId: expenseId,
        action: "delete" as const,
      },
    ]);

    return inserted;
  });

  const rows = await getDb(db).query.expense.findMany({
    where: and(inArray(expense.id, createdIds), notDeleted(expense)),
    ...relations.expense.withProject,
  });
  return rows.map(dbExpenseToAPI);
};

/**
 * Merge charges the backfill couldn't group — the 364 singletons with no order
 * id, which no key could have joined. Re-points expenses, moves documents,
 * soft-deletes the losers.
 *
 * Two refusals, both structural rather than stylistic:
 *
 * 1. **Across vendors** — re-pointing a charge to another vendor would silently
 *    rewrite who was paid. The merge is a grouping operation, not a correction.
 * 2. **Two non-null order ids** — the partial-unique `(vendorId, orderId)` index
 *    means both sides can't survive, and one of them isn't the charge the caller
 *    named. Two real order ids are two real transactions; that's a no-op, not a
 *    merge.
 *
 * A loser's own null-`orderId` is fine, and a loser's order id can be adopted by
 * the keeper when the keeper has none — that's the common shape (a hand-entered
 * charge later matched to a vendor export).
 */
export const mergePurchases = async (
  db: Database,
  input: MergePurchasesInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const { keepId, mergeIds } = input;

  const losers = mergeIds.filter((id) => id !== keepId);
  if (losers.length === 0) return getPurchaseByID(db, keepId);

  await withTransaction(db, async (tx) => {
    // Lock every row first so a concurrent merge can't interleave and leave the
    // unique index deciding the outcome.
    await lockAndValidateForDelete(
      tx,
      purchase,
      [keepId, ...losers],
      "Purchase",
    );

    const rows = await tx.query.purchase.findMany({
      where: and(
        inArray(purchase.id, [keepId, ...losers]),
        notDeleted(purchase),
      ),
      columns: { id: true, vendorId: true, orderId: true },
    });

    const keeper = rows.find((r) => r.id === keepId);
    if (!keeper) {
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        `Purchase not found: ${keepId}`,
      );
    }

    const crossVendor = rows.filter((r) => r.vendorId !== keeper.vendorId);
    if (crossVendor.length > 0) {
      throw createAppError(
        "PURCHASE_MERGE_VENDOR_MISMATCH",
        `Cannot merge charges across vendors: ${crossVendor.map((r) => r.id).join(", ")} belong to a different vendor than ${keepId}.`,
      );
    }

    const orderIdBearers = rows.filter((r) => r.orderId !== null);
    if (orderIdBearers.length > 1) {
      throw createAppError(
        "PURCHASE_MERGE_ORDER_COLLISION",
        `Cannot merge charges that each carry an order id (${orderIdBearers.map((r) => r.orderId).join(", ")}) — those are separate transactions.`,
      );
    }

    // ORDER MATTERS: soft-delete the losers BEFORE the keeper adopts an order id.
    // The unique index is partial on `deletedAt IS NULL`, so while a loser is
    // still live, writing its order id onto the keeper makes two live rows share
    // `(vendorId, orderId)` and the index aborts the whole merge. Deleting first
    // vacates the slot.
    await tx
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(and(inArray(purchase.id, losers), notDeleted(purchase)));

    // The keeper adopts the single surviving order id, if a loser held it — the
    // common shape, a hand-entered charge later matched to a vendor export.
    const adopted = orderIdBearers[0];
    if (adopted && adopted.id !== keepId) {
      await tx
        .update(purchase)
        .set({ orderId: adopted.orderId })
        .where(eq(purchase.id, keepId));
    }

    await tx
      .update(expense)
      .set({ purchaseId: keepId })
      .where(and(inArray(expense.purchaseId, losers), notDeleted(expense)));

    // Documents follow their charge. `onConflictDoNothing` covers the case where
    // the same Image is already filed against the keeper (a statement spanning
    // both charges) — the partial-unique (purchaseId, imageId) would otherwise
    // abort the whole merge.
    const movingImages = await tx.query.purchaseImage.findMany({
      where: and(
        inArray(purchaseImage.purchaseId, losers),
        notDeleted(purchaseImage),
      ),
      columns: { id: true, imageId: true, sortOrder: true },
    });
    if (movingImages.length > 0) {
      await tx
        .insert(purchaseImage)
        .values(
          movingImages.map((img) => ({
            purchaseId: keepId,
            imageId: img.imageId,
            sortOrder: img.sortOrder,
          })),
        )
        .onConflictDoNothing();
      await tx
        .update(purchaseImage)
        .set({ deletedAt: new Date() })
        .where(
          and(
            inArray(purchaseImage.purchaseId, losers),
            notDeleted(purchaseImage),
          ),
        );
    }

    await logAuditEntries(tx, actor, [
      {
        entityType: "purchase" as const,
        entityId: keepId,
        action: "update" as const,
        changes: { mergedFrom: { from: null, to: losers } },
      },
      ...losers.map((id) => ({
        entityType: "purchase" as const,
        entityId: id,
        action: "delete" as const,
      })),
    ]);
  });

  return getPurchaseByID(db, keepId);
};

/**
 * Soft-delete charges.
 *
 * Removal-path invariant (root CLAUDE.md, guard-enforced): the same transaction
 * soft-deletes the charge's `PurchaseImage` rows and NULLS `purchaseId` on its
 * expenses. Nulling rather than cascading is the point — an expense is the money,
 * and deleting a charge must never delete spend. Those rows fall back to reading
 * as "no vendor recorded", which is exactly what they are once the charge is gone.
 *
 * Neither `Purchase` nor `Vendor` is in the embedding pipeline in v1, so there
 * are no `EntityEmbedding` rows to clean up here.
 */
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
      .update(expense)
      .set({ purchaseId: null })
      .where(and(inArray(expense.purchaseId, ids), notDeleted(expense)));

    await tx
      .update(purchaseImage)
      .set({ deletedAt: now })
      .where(
        and(inArray(purchaseImage.purchaseId, ids), notDeleted(purchaseImage)),
      );

    await tx
      .update(purchase)
      .set({ deletedAt: now })
      .where(and(inArray(purchase.id, ids), notDeleted(purchase)));

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

/**
 * Charges whose lines don't add up to what the charge said it was.
 *
 * A **soft** flag only: this is a read, nothing calls it on a write path, and no
 * cost is ever back-computed from `statedTotal`. Mismatch is frequently correct
 * (a partial refund reduces a line without changing what the charge stated), so
 * this is a worklist, not an error.
 */
export const findPurchasesNotReconciling = async (
  db: Database,
): Promise<PurchaseOut[]> => {
  const rows = await getDb(db)
    .select(purchaseColumns)
    .from(purchase)
    .where(and(notDeleted(purchase), isNotNull(purchase.statedTotal)))
    .orderBy(desc(purchase.date));

  return rows
    .map((row) => dbPurchaseToAPI(row))
    .filter(
      (p) =>
        p.statedTotal !== null &&
        Math.abs(p.statedTotal - p.expenseTotal) > 0.01,
    );
};
