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
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type ExpenseId,
  type PurchaseId,
  unsafePurchaseId,
  unsafePurchaseShortcode,
  unsafeVendorShortcode,
  type VendorId,
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
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
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
  getDb,
  lockAndValidateForDelete,
  nextImageSortOrder,
  notDeleted,
  presenceCondition,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { dbExpenseToAPI } from "~/server/repo/expense/helpers";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";
import { assertVendorLive } from "~/server/repo/vendor";

export const PURCHASE_DELETE_EDGE_POLICY = {
  "Expense.purchaseId": {
    code: "clear-live-fk-with-audit",
    effect: "detach",
    description:
      "Deleting a charge nulls its expenses' purchaseId rather than deleting them — an expense is the money, and deleting a charge must never delete spend. Each detach is logged to the audit trail.",
  },
  "PurchaseImage.purchaseId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the purchase; the underlying images are not.",
  },
} as const satisfies IncomingEdgePolicy<"purchase", OperationDisposition>;

export const PURCHASE_MERGE_EDGE_POLICY = {
  "Expense.purchaseId": {
    code: "repoint-live-fk-with-audit",
    effect: "repoint",
    description:
      "Merging a charge re-points its expenses onto the surviving charge, logged to the audit trail.",
  },
  "PurchaseImage.purchaseId": {
    code: "move-dedupe-and-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed charge's images move onto the survivor, skipping any already filed there, and the source associations are soft-deleted.",
  },
} as const satisfies IncomingEdgePolicy<"purchase", OperationDisposition>;

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

// The vendor's public id, denormalized alongside its name so a charge row can
// link to the vendor without a second query.
const purchaseVendorShortcode = correlated<string | null>(
  `(SELECT v."shortcode" FROM "Vendor" v
     WHERE v."id" = "Purchase"."vendorId" AND v."deletedAt" IS NULL)`,
);

const purchaseColumns = {
  id: purchase.id,
  shortcode: purchase.shortcode,
  vendorId: purchase.vendorId,
  orderId: purchase.orderId,
  date: purchase.date,
  statedTotal: purchase.statedTotal,
  notes: purchase.notes,
  createdAt: purchase.createdAt,
  updatedAt: purchase.updatedAt,
  vendorName: purchaseVendorName,
  vendorShortcode: purchaseVendorShortcode,
  expenseCount: purchaseExpenseCount,
  expenseTotal: purchaseExpenseTotal,
} as const;

type PurchaseRow = {
  id: PurchaseId;
  shortcode: string;
  vendorId: VendorId;
  orderId: string | null;
  date: string | null;
  statedTotal: number | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  vendorName: string | null;
  vendorShortcode: string | null;
  expenseCount: number;
  expenseTotal: number;
};

const dbPurchaseToAPI = (
  row: PurchaseRow,
  images: PurchaseOut["images"] = [],
): PurchaseOut => ({
  id: row.id,
  shortcode: unsafePurchaseShortcode(row.shortcode),
  vendorId: row.vendorId,
  orderId: row.orderId,
  date: row.date,
  statedTotal: row.statedTotal,
  notes: row.notes,
  vendorName: row.vendorName,
  vendorShortcode: row.vendorShortcode
    ? unsafeVendorShortcode(row.vendorShortcode)
    : null,
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

/**
 * The named charge must exist and be live — the `Purchase` analogue of
 * `assertVendorLive` / `assertProjectLive`, for the same FK-checks-existence-not-
 * `deletedAt` reason. `expenseCreateInput.purchaseId` and
 * `expenseUpdateData.purchaseId` are caller-supplied ids that bypass
 * `resolveCharge`'s name resolution entirely, so this is the only thing standing
 * between a public API call and an expense attached to a tombstoned charge.
 */
export const assertPurchaseLive = async (
  tx: DrizzleTransaction,
  id: PurchaseId,
): Promise<void> => {
  const live = await tx.query.purchase.findFirst({
    where: and(eq(purchase.id, id), notDeleted(purchase)),
    columns: { id: true },
  });
  if (!live) {
    throw createAppError(
      "PURCHASE_NOT_FOUND",
      `Purchase ${id} does not exist or has been deleted`,
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
 * Get full purchase details by shortcode. Returns null if the code doesn't
 * resolve to a live purchase.
 */
export const getPurchaseByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<PurchaseOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "purchase");
  return id ? getPurchaseByID(db, unsafePurchaseId(id)) : null;
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
    const created = await insertWithShortcode(db, "purchase", {
      vendorId: input.vendorId,
      orderId: null,
      date: input.date ?? null,
    });
    return created.id;
  }

  const { row } = await findOrCreateWithShortcode(db, "purchase", {
    // Must match the partial-unique index exactly — it's how `findOrCreate`
    // re-finds the winner when it loses the insert race.
    where: and(
      eq(purchase.vendorId, input.vendorId),
      eq(purchase.orderId, orderId),
      notDeleted(purchase),
    ),
    values: () => ({
      vendorId: input.vendorId,
      orderId,
      date: input.date ?? null,
    }),
  });
  return row.id;
};

export const createPurchase = async (
  db: Database,
  data: PurchaseCreateInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const id = await withTransaction(db, async (tx) => {
    // An FK proves the vendor row exists, not that it's live.
    await assertVendorLive(tx, data.vendorId);
    const created = await insertWithShortcode(tx, "purchase", {
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

    if (data.vendorId !== undefined) {
      await assertVendorLive(tx, data.vendorId);
    }

    // This is the one writer that can move BOTH halves of the partial-unique
    // `(vendorId, orderId)` key, so it is the one that can collide. Two charges
    // legitimately share an order id across vendors — order ids are only unique
    // per vendor (Tool Nirvana's "#11325") — so moving a charge to a vendor that
    // already holds that order id raises 23505. Nothing maps that to an AppError,
    // so it surfaced as an untyped 500 instead of the message
    // `renameChargeOrderId` was built to give. Pre-checked with a SELECT for the
    // same reason it is there: a failed statement poisons the transaction.
    const nextVendorId = data.vendorId ?? before.vendorId;
    const nextOrderId =
      data.orderId === undefined
        ? before.orderId
        : data.orderId?.trim() || null;
    if (
      nextOrderId !== null &&
      (nextVendorId !== before.vendorId || nextOrderId !== before.orderId)
    ) {
      const [clash] = await tx
        .select({ id: purchase.id })
        .from(purchase)
        .where(
          and(
            eq(purchase.vendorId, nextVendorId),
            eq(purchase.orderId, nextOrderId),
            ne(purchase.id, id),
            notDeleted(purchase),
          ),
        )
        .limit(1);
      if (clash) {
        throw createAppError(
          "PURCHASE_MERGE_ORDER_COLLISION",
          `Another charge for this vendor already carries order id ${nextOrderId}. Merge the two charges instead of moving this one onto it.`,
        );
      }
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
      const row = await insertWithShortcode(tx, "expense", {
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

    // Removal-path invariant (root CLAUDE.md, guard-enforced): this is a delete
    // path like any other, so the original's embedding goes in the SAME
    // transaction. `expense` is `searchable: true`, so skipping this leaves a live
    // `EntityEmbedding` row pointing at a dead id — semantic search keeps
    // returning a result that renders blank, `findOrphanedEntityEmbeddings` flags
    // it, and soft deletes aren't restorable so there's no clean recovery.
    await softDeleteEntityEmbeddingsTx(tx, "expense", [expenseId]);

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
 * Rename a charge's order id in place, or report that it can't be.
 *
 * Correcting a typo'd order id on a charge whose only line is the expense being
 * edited should EDIT that charge, not abandon it for a fresh one — the charge's
 * `statedTotal` and filed documents are the whole reason the row exists. See
 * `resolveCharge` for which writes reach this.
 *
 * Returns `false` when a live charge already holds `(vendorId, orderId)`, which
 * the partial-unique index would refuse. Detected with a SELECT rather than by
 * catching the constraint error: a failed statement poisons the surrounding
 * transaction, so the caller could not then fall back to attaching to the winner.
 */
export const renameChargeOrderId = async (
  tx: DrizzleTransaction,
  id: PurchaseId,
  orderId: string | null,
  actor: ActorContext,
): Promise<boolean> => {
  const [self] = await tx
    .select({ vendorId: purchase.vendorId, orderId: purchase.orderId })
    .from(purchase)
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .limit(1);
  if (!self) return false;

  if (orderId !== null) {
    const [clash] = await tx
      .select({ id: purchase.id })
      .from(purchase)
      .where(
        and(
          eq(purchase.vendorId, self.vendorId),
          eq(purchase.orderId, orderId),
          ne(purchase.id, id),
          notDeleted(purchase),
        ),
      )
      .limit(1);
    if (clash) return false;
  }

  await tx.update(purchase).set({ orderId }).where(eq(purchase.id, id));

  // Audited, because this is the COMMON path: the only shape both Order # inline
  // editors send is `{ orderId }`, which lands here and returns `undefined` to
  // `resolveCharge` — so `expenseCrud.update` sees no column change either and
  // emits nothing. Without this row, correcting an order id (the central
  // purchase-import reconciliation action) left no trace anywhere.
  if (self.orderId !== orderId) {
    await logAuditEntry(tx, actor, {
      entityType: "purchase",
      entityId: id,
      action: "update",
      changes: { orderId: { from: self.orderId, to: orderId } },
    });
  }
  return true;
};

/**
 * Move one charge's contents onto another and soft-delete it.
 *
 * The shared core of both merges: `mergePurchases` (two charges of one vendor)
 * and `mergeVendors` (two charges that turned out to be the same order under two
 * spellings of one vendor). Extracted rather than duplicated because the
 * `onConflictDoNothing` below is a non-obvious correctness detail, and a second
 * hand-written copy would drift from it.
 *
 * Callers own the ordering constraints around the partial-unique
 * `(vendorId, orderId)` index — this helper only ever soft-deletes `deadId`, so
 * it frees a slot and never claims one.
 *
 * Re-pointing an expense is an AUDITED change to its `purchaseId`, exactly as it
 * is on the single-row `updateExpense` path (where `purchaseId` is in
 * `auditUpdateFields`) and in `linkExpensesToPurchase`. Without these rows a merge
 * would silently move money between charges with no trail — the one thing the
 * audit log exists to prevent.
 */
export const foldChargeInto = async (
  tx: DrizzleTransaction,
  deadId: PurchaseId,
  survivorId: PurchaseId,
  actor: ActorContext,
): Promise<void> => {
  // Charge-level truth has to come along, not just the lines and documents.
  // `statedTotal` especially: it is the reconciliation cue the whole `Purchase`
  // table exists to hold, and dropping it here meant a vendor typo-fix on a
  // single-line charge silently destroyed it (the fold is reached from
  // `resolveCharge`, not only from an explicit merge).
  //
  // Only fills a field the survivor DOESN'T have — never overwrites. When both
  // carry a `statedTotal` and they disagree, the survivor's stands and the
  // discarded one is named in the audit row rather than vanishing: two different
  // stated totals is a real conflict and picking silently would be the worse
  // failure.
  const [dead] = await tx
    .select({
      statedTotal: purchase.statedTotal,
      notes: purchase.notes,
      date: purchase.date,
    })
    .from(purchase)
    .where(eq(purchase.id, deadId))
    .limit(1);
  const [survivor] = await tx
    .select({
      statedTotal: purchase.statedTotal,
      notes: purchase.notes,
      date: purchase.date,
    })
    .from(purchase)
    .where(eq(purchase.id, survivorId))
    .limit(1);

  const carried = buildPartialUpdateValues({
    statedTotal:
      survivor?.statedTotal == null && dead?.statedTotal != null
        ? dead.statedTotal
        : undefined,
    notes:
      survivor?.notes == null && dead?.notes != null ? dead.notes : undefined,
    date: survivor?.date == null && dead?.date != null ? dead.date : undefined,
  });
  if (Object.keys(carried).length > 0) {
    await tx.update(purchase).set(carried).where(eq(purchase.id, survivorId));
  }

  const discardedStatedTotal =
    survivor?.statedTotal != null &&
    dead?.statedTotal != null &&
    survivor.statedTotal !== dead.statedTotal
      ? dead.statedTotal
      : undefined;

  const moving = await tx
    .select({ id: expense.id })
    .from(expense)
    .where(and(eq(expense.purchaseId, deadId), notDeleted(expense)));

  await tx
    .update(expense)
    .set({ purchaseId: survivorId })
    .where(and(eq(expense.purchaseId, deadId), notDeleted(expense)));

  await logAuditEntries(
    tx,
    actor,
    moving.map((row) => ({
      entityType: "expense" as const,
      entityId: row.id,
      action: "update" as const,
      changes: { purchaseId: { from: deadId, to: survivorId } },
    })),
  );

  // Documents follow their charge. `onConflictDoNothing` covers the case where
  // the same Image is already filed against the survivor (a statement spanning
  // both charges) — the partial-unique (purchaseId, imageId) would otherwise
  // abort the whole merge.
  const movingImages = await tx.query.purchaseImage.findMany({
    where: and(eq(purchaseImage.purchaseId, deadId), notDeleted(purchaseImage)),
    columns: { imageId: true, sortOrder: true },
  });
  if (movingImages.length > 0) {
    await tx
      .insert(purchaseImage)
      .values(
        movingImages.map((img) => ({
          purchaseId: survivorId,
          imageId: img.imageId,
          sortOrder: img.sortOrder,
        })),
      )
      .onConflictDoNothing();
    await tx
      .update(purchaseImage)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(purchaseImage.purchaseId, deadId), notDeleted(purchaseImage)),
      );
  }

  await tx
    .update(purchase)
    .set({ deletedAt: new Date() })
    .where(and(eq(purchase.id, deadId), notDeleted(purchase)));

  // The charge itself gets a `delete` entry, and the survivor an `update` naming
  // what it absorbed — so a fold is reconstructible from the log rather than
  // inferable only from the absence of a row.
  await logAuditEntries(tx, actor, [
    {
      entityType: "purchase" as const,
      entityId: survivorId,
      action: "update" as const,
      changes: {
        foldedIn: { from: null, to: deadId },
        ...(Object.keys(carried).length > 0
          ? { carriedOver: { from: null, to: carried } }
          : {}),
        ...(discardedStatedTotal !== undefined
          ? {
              discardedStatedTotal: {
                from: discardedStatedTotal,
                to: survivor?.statedTotal ?? null,
              },
            }
          : {}),
      },
    },
    {
      entityType: "purchase" as const,
      entityId: deadId,
      action: "delete" as const,
    },
  ]);
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

/** One of the two structural refusals {@link checkPurchaseMergeSet} enforces. */
type PurchaseMergeViolation =
  | { kind: "cross-vendor"; offendingIds: PurchaseId[] }
  | { kind: "order-collision"; offendingIds: PurchaseId[]; orderIds: string[] };

/**
 * The two refusals `mergePurchases` enforces — computed without throwing, so
 * `previewMergePurchases` can surface them as blockers instead of only an
 * error toast after the mutation has already been attempted. Both call sites
 * read the same rows and run the SAME two checks; see `mergePurchases`' own
 * doc for why each is structural rather than stylistic.
 */
const checkPurchaseMergeSet = (
  rows: Array<{ id: PurchaseId; vendorId: VendorId; orderId: string | null }>,
  keeper: { id: PurchaseId; vendorId: VendorId },
): PurchaseMergeViolation[] => {
  const violations: PurchaseMergeViolation[] = [];

  const crossVendor = rows.filter((r) => r.vendorId !== keeper.vendorId);
  if (crossVendor.length > 0) {
    violations.push({
      kind: "cross-vendor",
      offendingIds: crossVendor.map((r) => r.id),
    });
  }

  const orderIdBearers = rows.filter((r) => r.orderId !== null);
  if (orderIdBearers.length > 1) {
    violations.push({
      kind: "order-collision",
      offendingIds: orderIdBearers.map((r) => r.id),
      orderIds: orderIdBearers.map((r) => r.orderId as string),
    });
  }

  return violations;
};

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

    const violations = checkPurchaseMergeSet(rows, keeper);
    for (const violation of violations) {
      if (violation.kind === "cross-vendor") {
        throw createAppError(
          "PURCHASE_MERGE_VENDOR_MISMATCH",
          `Cannot merge charges across vendors: ${violation.offendingIds.join(", ")} belong to a different vendor than ${keepId}.`,
        );
      }
      throw createAppError(
        "PURCHASE_MERGE_ORDER_COLLISION",
        `Cannot merge charges that each carry an order id (${violation.orderIds.join(", ")}) — those are separate transactions.`,
      );
    }

    // orderIdBearers is used below to decide which order id (if any) the
    // keeper adopts — recomputed here rather than threaded through
    // `checkPurchaseMergeSet` because that function's only job is validation.
    const orderIdBearers = rows.filter((r) => r.orderId !== null);

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

    // One `foldChargeInto` per loser rather than two bulk statements: it is the
    // shared core (expenses re-pointed WITH audit rows, documents moved with the
    // onConflictDoNothing that a statement spanning both charges needs, loser
    // soft-deleted). Hand-writing it here is what let this path silently move
    // money between charges with no audit trail while `linkExpensesToPurchase`
    // logged the same change. The soft-delete above already vacated the index
    // slot, so the one inside is a no-op.
    for (const loser of losers) {
      await foldChargeInto(tx, loser, keepId, actor);
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

    // Detaching a line is an audited change to its `purchaseId`, same as every
    // other writer of that column. Without these rows, spend silently loses its
    // vendor attribution with only the charge's own `delete` entry to hint at it —
    // and since `vendor`/`orderId` resolve THROUGH this column, the row's whole
    // provenance goes with it.
    const detaching = await tx
      .select({ id: expense.id, purchaseId: expense.purchaseId })
      .from(expense)
      .where(and(inArray(expense.purchaseId, ids), notDeleted(expense)));

    await tx
      .update(expense)
      .set({ purchaseId: null })
      .where(and(inArray(expense.purchaseId, ids), notDeleted(expense)));

    await logAuditEntries(
      tx,
      actor,
      detaching.map((row) => ({
        entityType: "expense" as const,
        entityId: row.id,
        action: "update" as const,
        changes: { purchaseId: { from: row.purchaseId, to: null } },
      })),
    );

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
 * What `deletePurchases` would do to the given charges, without doing it.
 *
 * Reads the SAME `PURCHASE_DELETE_EDGE_POLICY` this file's mutation
 * implements. Both edges are non-blocking (`detach`/`soft-delete`), so this
 * preview has only `changes` — nothing refuses a purchase delete. Neither
 * `Purchase` nor `Vendor` is in the embedding pipeline (see `deletePurchases`'
 * own doc), so there are no `sideEffects` to report either.
 *
 * Advisory only. `deletePurchases` still re-runs its own transaction; nothing
 * here is a lock or a permission.
 */
export const previewDeletePurchases = async (
  db: Database,
  ids: PurchaseId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  if (ids.length === 0) return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = getDb(db);

  const changes = present([
    impact({
      disposition: PURCHASE_DELETE_EDGE_POLICY["Expense.purchaseId"],
      edgeKey: "Expense.purchaseId",
      label: "expenses detached",
      byTargetId: await countByTarget(
        dbClient,
        expense,
        expense.purchaseId,
        ids,
      ),
    }),
    impact({
      disposition: PURCHASE_DELETE_EDGE_POLICY["PurchaseImage.purchaseId"],
      edgeKey: "PurchaseImage.purchaseId",
      label: "documents removed",
      byTargetId: await countByTarget(
        dbClient,
        purchaseImage,
        purchaseImage.purchaseId,
        ids,
      ),
    }),
  ]);

  return { blockers: [], changes, sideEffects: [] };
};

/**
 * What `mergePurchases` would do to the given charges, without doing it.
 *
 * Reads the SAME `checkPurchaseMergeSet` the mutation calls before it writes
 * anything, so a cross-vendor or order-id-collision merge surfaces as a
 * `blocker` here instead of only an error toast after the dialog's already
 * confirmed. Reads the SAME `PURCHASE_MERGE_EDGE_POLICY` for the `changes` —
 * `mergePurchases` folds every loser directly into `keepId` (no per-order
 * survivor resolution like `mergeVendors`; see its own doc for why merging
 * MORE than one order-id-bearing charge is refused outright rather than
 * resolved), so both edges' counts are a plain `countByTarget` over the
 * losers. Source purchases removed has no declared `Purchase` edge (nothing
 * points a `Purchase` at another `Purchase`), so it's a `sideEffect`.
 *
 * Advisory only. `mergePurchases` still re-runs the same validation and
 * recomputes its own fold set inside its own transaction; nothing here is a
 * lock or a permission.
 */
export const previewMergePurchases = async (
  db: Database,
  input: { keepId: PurchaseId; mergeIds: PurchaseId[] },
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  const { keepId } = input;
  const losers = input.mergeIds.filter((id) => id !== keepId);
  if (losers.length === 0)
    return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = getDb(db);
  const rows = await dbClient.query.purchase.findMany({
    where: and(inArray(purchase.id, [keepId, ...losers]), notDeleted(purchase)),
    columns: { id: true, vendorId: true, orderId: true },
  });

  const keeper = rows.find((r) => r.id === keepId);
  if (!keeper) {
    // Mirrors the mutation's own `PURCHASE_NOT_FOUND` refusal, surfaced as a
    // blocker rather than thrown — a preview reports, it doesn't crash.
    return {
      blockers: present([
        impact({
          disposition: {
            code: "block-purchase-not-found",
            effect: "block",
            description:
              "The keeper charge doesn't exist or has already been deleted.",
          },
          label: "missing keeper charge",
          byTargetId: { [keepId]: 1 },
        }),
      ]),
      changes: [],
      sideEffects: [],
    };
  }

  const violations = checkPurchaseMergeSet(rows, keeper);
  const blockers = present(
    violations.map((violation) =>
      violation.kind === "cross-vendor"
        ? impact({
            disposition: {
              code: "block-cross-vendor-merge",
              effect: "block",
              description:
                "Purchases across different vendors can't be merged — a merge re-points a charge's expenses and documents, never its vendor.",
            },
            label: "charges belonging to a different vendor",
            byTargetId: Object.fromEntries(
              violation.offendingIds.map((id) => [id, 1]),
            ),
          })
        : impact({
            disposition: {
              code: "block-order-collision-merge",
              effect: "block",
              description:
                "More than one charge in this merge set carries its own order id — those are separate transactions and can't be merged.",
            },
            label: "charges each carrying an order id",
            byTargetId: Object.fromEntries(
              violation.offendingIds.map((id) => [id, 1]),
            ),
          }),
    ),
  );

  const changes = present([
    impact({
      disposition: PURCHASE_MERGE_EDGE_POLICY["Expense.purchaseId"],
      edgeKey: "Expense.purchaseId",
      label: "expenses re-pointed",
      byTargetId: await countByTarget(
        dbClient,
        expense,
        expense.purchaseId,
        losers,
      ),
    }),
    impact({
      disposition: PURCHASE_MERGE_EDGE_POLICY["PurchaseImage.purchaseId"],
      edgeKey: "PurchaseImage.purchaseId",
      label: "documents moved and deduplicated",
      byTargetId: await countByTarget(
        dbClient,
        purchaseImage,
        purchaseImage.purchaseId,
        losers,
      ),
    }),
  ]);

  const sideEffects = present([
    impact({
      disposition: {
        code: "soft-delete-source-purchase",
        effect: "soft-delete",
        description: "The merged-away charges are soft-deleted.",
      },
      label: "source purchases removed",
      byTargetId: Object.fromEntries(losers.map((id) => [id, 1])),
    }),
  ]);

  return { blockers, changes, sideEffects };
};
