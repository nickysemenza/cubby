/**
 * Purchase repository — one vendor order/receipt event per row.
 *
 * `Vendor ──< Purchase ──< Expense`. See packages/schemas/src/purchase.ts for
 * the domain doc: why 11 progress payments are 11 purchases and not one, why
 * `statedTotal` is never spend, and why there is deliberately no
 * `splitPurchase`.
 *
 * The partial-unique `(vendorId, orderId) WHERE orderId IS NOT NULL AND live`
 * index is the load-bearing constraint in this file. It is what makes
 * `findOrCreatePurchase` unambiguous on the import hot path (one order can only
 * ever be one Purchase, so there's no ambiguous branch), and it is what
 * `mergePurchases` has to defend against — two rows both carrying the same
 * non-null order id can't both survive a merge.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import { inferExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  type ExpenseId,
  type FinancialTransactionId,
  type ProductId,
  type PurchaseId,
  type PurchaseShortcode,
  unsafeExpenseId,
  unsafeImageShortcode,
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
  MergePurchasesOut,
  PurchaseCreateInput,
  PurchaseFilters,
  PurchaseOut,
  PurchaseUpdateInput,
  ReclassifyPurchaseDocumentInput,
  SplitExpenseInput,
} from "@cubby/schemas/purchase";
import {
  purchaseSortableFields,
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
} from "@cubby/schemas/purchase";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  expense,
  expenseAttribution,
  financialTransactionAllocation,
  image,
  ledgerSourceClaim,
  purchase,
  purchaseImage,
  purchaseProduct,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  loadPurchaseDataQualities,
  purchaseAnyDataGapCondition,
  purchaseDataGapCondition,
  purchaseDefectCondition,
  purchaseNeedsDataCondition,
  touchDataQualityTargets,
} from "~/server/repo/data-quality";
import {
  applyImageOrder,
  associatePendingImages,
  auditDateWhereConditions,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  correlated,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  lockAndValidateForDelete,
  nextImageSortOrder,
  notDeleted,
  presenceCondition,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  assertQuantitySignMatchesCost,
  dbExpenseToAPI,
  resolveDefaultProjectId,
} from "~/server/repo/expense/helpers";
import {
  calculateFinancialReconciliation,
  postedRefundTotalSql,
  purchaseFinancialMismatchSql,
  settleableExpenseTotalSql,
  settleableUnpricedExpenseCountSql,
} from "~/server/repo/financial-reconciliation";
import {
  applyAllocationChanges,
  readAllocations,
  transactionIdsAllocatedTo,
} from "~/server/repo/financial-transaction-allocations";
import { detachImagesFromEntity } from "~/server/repo/image";
import { displayableImageSql } from "~/server/repo/image-displayability";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";
import {
  assertDistinctMergeTargets,
  finalizeMerge,
  repointEdge,
  resolveMergeTargets,
} from "~/server/repo/merge";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import {
  emptyPurchaseFinancialAggregate,
  loadPurchaseFinancialAggregates,
  type PurchaseFinancialAggregate,
} from "~/server/repo/purchase-financial-aggregates";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { cascadeRemoval, removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveLiveShortcode,
  resolveOrThrow,
  resolveShortcodes,
} from "~/server/repo/shortcode-resolver";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";

export const PURCHASE_DELETE_EDGE_POLICY = {
  "Expense.purchaseId": {
    code: "clear-live-fk-with-audit",
    effect: "detach",
    description:
      "Deleting a purchase nulls its expenses' purchaseId rather than deleting them — an expense is the money, and deleting a purchase must never delete spend. Each detach is logged to the audit trail.",
  },
  "PurchaseImage.purchaseId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the purchase, and each file is\n      deleted too unless something else still references it.",
  },
  "PurchaseProduct.purchaseId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Product links are soft-deleted with the purchase; the Products themselves are not.",
  },
  "FinancialTransactionAllocation.purchaseId": {
    code: "soft-delete-allocations-of-affected-transactions",
    effect: "soft-delete",
    description:
      "Deleting a purchase removes its settlement allocations — and, for a transaction that was split across this purchase and others, the sibling slices too, because a partial allocation set is not a legal state: a transaction has either none, or a set summing to its amount. Those transactions revert to unlinked evidence on their accounts; no amount changes. For the ordinary single-allocation transaction this is exactly equivalent to detaching it.",
  },
} as const satisfies IncomingEdgePolicy<"purchase", OperationDisposition>;

export const PURCHASE_MERGE_EDGE_POLICY = {
  "Expense.purchaseId": {
    code: "repoint-live-fk-with-audit",
    effect: "repoint",
    description:
      "Merging a purchase re-points its expenses onto the surviving purchase, logged to the audit trail.",
  },
  "PurchaseImage.purchaseId": {
    code: "move-dedupe-and-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed purchase's images move onto the survivor, skipping any already filed there, and the source associations are soft-deleted.",
  },
  "PurchaseProduct.purchaseId": {
    code: "move-dedupe-and-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed purchase's product links move onto the survivor, skipping products already linked there, and the source links are soft-deleted.",
  },
  "FinancialTransactionAllocation.purchaseId": {
    code: "move-and-sum-amounts-then-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed purchase's settlement allocations move onto the survivor. Where BOTH purchases held a slice of the SAME transaction the two slices are SUMMED into one row rather than one being skipped — unlike images and product links an allocation carries an amount, so dropping the duplicate would destroy evidence and break the transaction's sum-to-amount invariant. The source rows are soft-deleted.",
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
 * Every fragment below is hand-qualified raw SQL wrapped in `correlated()` —
 * see its doc comment in `database-helpers/query.ts` for the
 * `buildSelection`-strips-prefixes trap that rule exists to avoid, and why
 * `"Purchase"."id"` must stay fully qualified.
 */
const purchaseExpenseCount = correlated<number>(
  `(SELECT count(*)::int FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL)`,
);

const purchaseExpenseTotal = correlated<number>(
  `(SELECT COALESCE(sum(e."cost"), 0)::double precision FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL)`,
);

const purchaseUnpricedExpenseCount = correlated<number>(
  `(SELECT count(*)::int FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id"
       AND e."cost" IS NULL AND e."deletedAt" IS NULL)`,
);

// Settlement compares against INCURRED spend only, so it gets its own pair of
// numbers from the shared fragments rather than reusing the two above.
// `expenseTotal` stays the full figure because that is what the purchase
// displays — a contract's total is worth seeing — but a `future: true` row
// cannot have settled, so including it would guarantee a mismatch.
const purchaseSettleableExpenseTotal = correlated<number>(
  settleableExpenseTotalSql('"Purchase"'),
);

const purchaseSettleableUnpricedExpenseCount = correlated<number>(
  settleableUnpricedExpenseCountSql('"Purchase"'),
);

const purchasePostedRefundTotal = correlated<number>(
  postedRefundTotalSql('"Purchase"'),
);

const purchaseDocumentCount = correlated<number>(
  `(SELECT count(*)::int FROM "PurchaseImage" pi
     JOIN "Image" i ON i."id" = pi."imageId" AND i."deletedAt" IS NULL
     WHERE pi."purchaseId" = "Purchase"."id" AND pi."deletedAt" IS NULL)`,
);

const purchaseVendorName = correlated<string | null>(
  `(SELECT v."name" FROM "Vendor" v
     WHERE v."id" = "Purchase"."vendorId" AND v."deletedAt" IS NULL)`,
);

// The vendor's public id, denormalized alongside its name so a charge row can
// link to the vendor without a second query. Deliberately NOT filtered on the
// vendor's own `deletedAt`: `purchase.vendorId` is a NOT NULL FK, and a
// shortcode is a permanent tombstone even past a soft delete (see
// "Shortcodes are the public id" in root CLAUDE.md), so this must always
// resolve — unlike `purchaseVendorName`, which deliberately goes null to
// signal "this vendor was soft-deleted".
const purchaseVendorShortcode = correlated<string>(
  `(SELECT v."shortcode" FROM "Vendor" v WHERE v."id" = "Purchase"."vendorId")`,
);

// The vendor's order-page URL pattern, pulled alongside its name so `orderUrl`
// can be derived without a second query. Gated on the vendor's liveness like
// `purchaseVendorName` (not like the shortcode): a soft-deleted vendor's order
// lookup is not an affordance worth offering.
const purchaseVendorOrderUrlTemplate = correlated<string | null>(
  `(SELECT v."orderUrlTemplate" FROM "Vendor" v
     WHERE v."id" = "Purchase"."vendorId" AND v."deletedAt" IS NULL)`,
);

const purchaseVendorLogoUrl = sql<string | null>`(
  SELECT logo."url" FROM "Vendor" v
  JOIN "Image" logo ON logo."id" = v."logoImageId"
  WHERE v."id" = ${sql.raw('"Purchase"."vendorId"')}
    AND v."deletedAt" IS NULL
    AND logo."deletedAt" IS NULL
    AND ${displayableImageSql("logo")}
)`;

const purchaseColumns = {
  id: purchase.id,
  shortcode: purchase.shortcode,
  orderId: purchase.orderId,
  displayLabel: purchase.displayLabel,
  date: purchase.date,
  statedTotal: purchase.statedTotal,
  notes: purchase.notes,
  createdAt: purchase.createdAt,
  updatedAt: purchase.updatedAt,
  vendorName: purchaseVendorName,
  vendorShortcode: purchaseVendorShortcode,
  vendorOrderUrlTemplate: purchaseVendorOrderUrlTemplate,
  vendorLogoUrl: purchaseVendorLogoUrl,
  expenseCount: purchaseExpenseCount,
  unpricedExpenseCount: purchaseUnpricedExpenseCount,
  expenseTotal: purchaseExpenseTotal,
  settleableExpenseTotal: purchaseSettleableExpenseTotal,
  settleableUnpricedExpenseCount: purchaseSettleableUnpricedExpenseCount,
  documentCount: purchaseDocumentCount,
} as const;

type PurchaseRow = {
  id: PurchaseId;
  shortcode: string;
  orderId: string | null;
  displayLabel: string | null;
  date: string;
  statedTotal: number | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  vendorName: string | null;
  vendorShortcode: string;
  vendorOrderUrlTemplate: string | null;
  vendorLogoUrl: string | null;
  expenseCount: number;
  unpricedExpenseCount: number;
  expenseTotal: number;
  settleableExpenseTotal: number;
  settleableUnpricedExpenseCount: number;
  documentCount: number;
};

const dbPurchaseToAPI = (
  row: PurchaseRow,
  dataQuality: PurchaseOut["dataQuality"],
  images: PurchaseOut["images"] = [],
  financial: PurchaseFinancialAggregate = emptyPurchaseFinancialAggregate(),
): PurchaseOut => ({
  id: unsafePurchaseShortcode(row.shortcode),
  vendorId: unsafeVendorShortcode(row.vendorShortcode),
  orderId: row.orderId,
  displayLabel: row.displayLabel,
  date: row.date,
  statedTotal: row.statedTotal,
  notes: row.notes,
  vendorName: row.vendorName,
  vendorLogo: row.vendorLogoUrl ? { url: row.vendorLogoUrl } : null,
  orderUrl: purchaseOrderUrl({
    orderUrlTemplate: row.vendorOrderUrlTemplate,
    orderId: row.orderId,
  }),
  expenseCount: Number(row.expenseCount),
  unpricedExpenseCount: Number(row.unpricedExpenseCount),
  expenseTotal: Number(row.expenseTotal),
  reconciliation: reconcilePurchase({
    statedTotal: row.statedTotal,
    expenseTotal: Number(row.expenseTotal),
    expenseCount: Number(row.expenseCount),
    unpricedExpenseCount: Number(row.unpricedExpenseCount),
    postedRefundTotal: financial.postedRefundTotal,
  }),
  documentCount: Number(row.documentCount),
  financialReconciliation: calculateFinancialReconciliation({
    settleableExpenseTotal: row.settleableExpenseTotal,
    settleableUnpricedExpenseCount: row.settleableUnpricedExpenseCount,
    ...financial,
  }),
  dataQuality,
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
      shortcode: image.shortcode,
      url: image.url,
      filename: image.filename,
      contentType: image.contentType,
      key: image.key,
      documentKind: purchaseImage.documentKind,
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
  return rows.map(({ shortcode, ...rest }) => ({
    ...rest,
    id: unsafeImageShortcode(shortcode),
  }));
};

/**
 * Add newly-uploaded documents, remove requested ones, and apply an explicit
 * display order. Mirrors `syncProductImages` (repo/product/update-helpers.ts)
 * exactly, including applying the order BEFORE the append so new documents always
 * land after the reordered existing set.
 *
 * `pendingImageIds`/`removeImageIds`/`imageOrder` all arrive as public `IMG-`
 * shortcodes (what `PurchaseOut.images[].id` and `create_file_upload` hand
 * back); `applyImageOrder`, `detachImagesFromEntity`, and
 * `associatePendingImages` all still take uuids, so this is the boundary that
 * resolves one to the other. A code that doesn't resolve is dropped rather
 * than thrown on — same as today's silent no-op for a uuid naming no live
 * row, since none of the three helpers below errors on an id that doesn't
 * match.
 */
const syncPurchaseImages = async (
  tx: DrizzleTransaction,
  id: PurchaseId,
  pendingImageIds: string[] | undefined,
  removeImageIds: string[] | undefined,
  imageOrder: string[] | undefined,
): Promise<string[]> => {
  let detachedImageKeys: string[] = [];

  if (imageOrder && imageOrder.length > 0) {
    const orderedIds = await resolveAllPresent(tx, "image", imageOrder);
    await applyImageOrder(
      tx,
      purchaseImage,
      purchaseImage.purchaseId,
      id,
      orderedIds,
    );
  }

  if (removeImageIds && removeImageIds.length > 0) {
    const idsToRemove = await resolveAllPresent(tx, "image", removeImageIds);
    ({ deletedKeys: detachedImageKeys } = await detachImagesFromEntity(
      tx,
      "purchase",
      id,
      idsToRemove,
    ));
  }

  if (pendingImageIds && pendingImageIds.length > 0) {
    const resolvedImageIds = await resolveAllPresent(
      tx,
      "image",
      pendingImageIds,
    );
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
      resolvedImageIds,
      startSortOrder,
    );
  }

  return detachedImageKeys;
};

/**
 * `filters.vendorId` arrives as a public `VendorShortcode`, but the column is a
 * uuid — so it is resolved first (`vendorUuids`) rather than compared directly,
 * which Postgres rejects outright with `invalid input syntax for type uuid`.
 * Mirrors `toUuids` on the expense side.
 */
const expenseStatusCondition = (
  values: PurchaseFilters["expenseStatus"],
): SQL | undefined => {
  const selected = values ? [values].flat() : [];
  if (selected.length === 0) return undefined;
  return or(
    selected.includes("empty") ? sql`${purchaseExpenseCount} = 0` : undefined,
    selected.includes("unpriced")
      ? sql`${purchaseUnpricedExpenseCount} > 0`
      : undefined,
    selected.includes("priced")
      ? sql`${purchaseExpenseCount} > 0 AND ${purchaseUnpricedExpenseCount} = 0`
      : undefined,
  );
};

const reconciliationCondition = (
  values: PurchaseFilters["reconciliation"],
): SQL | undefined => {
  const selected = values ? [values].flat() : [];
  if (selected.length === 0) return undefined;
  const toleranceInCents = Math.round(RECONCILIATION_TOLERANCE * 100);
  // `floor(x + .5)` is PostgreSQL's exact twin of JS `Math.round`, including
  // negative half-cent values (numeric `round()` rounds those away from zero).
  const gapInCents = sql`abs(
    floor((${purchase.statedTotal} * 100)::numeric + 0.5) -
    floor((${purchaseExpenseTotal} * 100)::numeric + 0.5)
  )`;
  const deltaInCents = sql`(
    floor((${purchaseExpenseTotal} * 100)::numeric + 0.5) -
    floor((${purchase.statedTotal} * 100)::numeric + 0.5)
  )`;
  const refundInCents = sql`floor((${purchasePostedRefundTotal} * 100)::numeric + 0.5)`;
  const refundAdjusted = sql`${purchaseUnpricedExpenseCount} = 0
    AND ${deltaInCents} < ${-toleranceInCents}
    AND ${refundInCents} = ${deltaInCents}`;
  // Mirrors the zero-expense guard in `reconcilePurchase`: once the totals fail
  // to match, a purchase with no lines is `unknown` rather than a mismatch, so
  // the filter agrees with the verdict the hydrated purchase carries.
  const comparable = sql`${purchase.statedTotal} IS NOT NULL
    AND (${gapInCents} <= ${toleranceInCents} OR ${purchaseExpenseCount} > 0)`;
  return or(
    selected.includes("unknown")
      ? or(isNull(purchase.statedTotal), sql`NOT (${comparable})`)
      : undefined,
    selected.includes("match")
      ? sql`${purchase.statedTotal} IS NOT NULL AND ${gapInCents} <= ${toleranceInCents}`
      : undefined,
    selected.includes("refund_adjusted")
      ? sql`${comparable} AND ${gapInCents} > ${toleranceInCents} AND ${refundAdjusted}`
      : undefined,
    selected.includes("mismatch")
      ? sql`${comparable} AND ${gapInCents} > ${toleranceInCents} AND NOT (${refundAdjusted})`
      : undefined,
  );
};

const documentPresenceCondition = (
  value: PurchaseFilters["documentPresenceFilter"],
): SQL | undefined =>
  value === "has"
    ? sql`${purchaseDocumentCount} > 0`
    : value === "none"
      ? sql`${purchaseDocumentCount} = 0`
      : undefined;

const buildPurchaseWhereClause = (
  filters: PurchaseFilters,
  vendorCondition: SQL | undefined,
) =>
  buildSearchConditions(
    purchase,
    [{ column: purchase.displayLabel, term: filters.displayLabelSearch }],
    [
      // The broad Purchase search is one term over two alternative identity
      // fields. Passing both through `searchFilters` would AND them together,
      // requiring the same text in both orderId AND displayLabel.
      filters.search
        ? or(
            formatSearchTerm(purchase.orderId, filters.search),
            formatSearchTerm(purchase.displayLabel, filters.search),
          )
        : undefined,
      ...auditDateWhereConditions(purchase, filters),
      vendorCondition,
      ...relatedWhereConditions("purchase", filters, purchase.id),
      eqAny(purchase.orderId, filters.orderId),
      presenceCondition(purchase.orderId, filters.orderIdPresenceFilter),
      presenceCondition(
        purchase.statedTotal,
        filters.statedTotalPresenceFilter,
      ),
      expenseStatusCondition(filters.expenseStatus),
      reconciliationCondition(filters.reconciliation),
      filters.financialReconciliation === "mismatch"
        ? sql.raw(purchaseFinancialMismatchSql('"Purchase"'))
        : undefined,
      documentPresenceCondition(filters.documentPresenceFilter),
      filters.dataStatus === "needs_data"
        ? purchaseNeedsDataCondition()
        : filters.dataStatus === "defect"
          ? purchaseDefectCondition()
          : filters.dataStatus === "complete"
            ? sql`NOT ${purchaseAnyDataGapCondition()}`
            : undefined,
      filters.dataGap
        ? or(...[filters.dataGap].flat().map(purchaseDataGapCondition))
        : undefined,
      filters.expenseTotalMin !== undefined
        ? sql`${purchaseExpenseCount} > ${purchaseUnpricedExpenseCount} AND ${purchaseExpenseTotal} >= ${filters.expenseTotalMin}`
        : undefined,
      filters.expenseTotalMax !== undefined
        ? sql`${purchaseExpenseCount} > ${purchaseUnpricedExpenseCount} AND ${purchaseExpenseTotal} <= ${filters.expenseTotalMax}`
        : undefined,
      filters.dateFrom
        ? sql`${purchase.date} >= ${filters.dateFrom}`
        : undefined,
      filters.dateTo ? sql`${purchase.date} <= ${filters.dateTo}` : undefined,
    ],
  );

/** Sorts over the joined vendor name and rollups — none are table columns. */
const resolvePurchaseSort = (sort: SortParams) => {
  const dir = sort.direction === "asc" ? asc : desc;
  if (sort.orderBy === "vendor") return [dir(purchaseVendorName)];
  if (sort.orderBy === "expenseCount") return [dir(purchaseExpenseCount)];
  if (sort.orderBy === "expenseTotal") return [dir(purchaseExpenseTotal)];
  if (sort.orderBy === "reconciliationGap") {
    return [dir(sql`abs(${purchaseExpenseTotal} - ${purchase.statedTotal})`)];
  }
  if (sort.orderBy === "documentCount") return [dir(purchaseDocumentCount)];
  return null;
};

export const purchaseList = async (
  db: Database,
  filters: PurchaseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
): Promise<{ data: PurchaseOut[]; count: number }> => {
  // An unknown code resolves to nothing and so matches nothing, which is what a
  // filter naming a missing vendor should do — not throw. `vendorUuids` alone
  // can't express that: `eqAny([])` is "no constraint" by design (see its doc
  // in database-helpers/query.ts), so a requested-but-unresolved vendor has to
  // become an explicit `sql\`false\`` here rather than being handed to `eqAny`
  // and silently dropping the filter (which would return every purchase).
  const vendorCodes = filters.vendorId ? [filters.vendorId].flat() : undefined;
  const vendorUuids = vendorCodes
    ? [...(await resolveShortcodes(db, vendorCodes)).values()]
        .filter((ref) => ref.entity === "vendor")
        .map((ref) => ref.id)
    : undefined;
  const vendorCondition = vendorCodes
    ? vendorUuids && vendorUuids.length > 0
      ? eqAny(purchase.vendorId, vendorUuids)
      : sql`false`
    : undefined;
  const whereClause = buildPurchaseWhereClause(filters, vendorCondition);
  const { take, skip } = buildTakeSkip(pagination);

  const { data: rows, count } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      getDb(db)
        .select(purchaseColumns)
        .from(purchase)
        .where(whereClause)
        .orderBy(
          ...buildOrderBy(purchase, sorts, [...purchaseSortableFields], {
            resolve: resolvePurchaseSort,
          }),
        )
        .limit(take)
        .offset(skip),
    count: () => countWhere(db, purchase, whereClause),
  });
  if (readIntent === "count") {
    return { data: [], count };
  }
  const [financialByPurchase, dataQualities] = await Promise.all([
    loadPurchaseFinancialAggregates(
      db,
      rows.map((row) => row.id),
    ),
    loadPurchaseDataQualities(
      db,
      rows.map((row) => row.id),
    ),
  ]);

  return {
    data: rows.map((row) =>
      dbPurchaseToAPI(
        row,
        dataQualities.get(row.id)!,
        [],
        financialByPurchase.get(row.id),
      ),
    ),
    count,
  };
};

export const getPurchaseByID = async (
  db: Database,
  id: PurchaseId,
): Promise<PurchaseOut> => {
  const [rows, images, financialByPurchase, dataQualities] = await Promise.all([
    getDb(db)
      .select(purchaseColumns)
      .from(purchase)
      .where(and(eq(purchase.id, id), notDeleted(purchase)))
      .limit(1),
    loadPurchaseImages(db, id),
    loadPurchaseFinancialAggregates(db, [id]),
    loadPurchaseDataQualities(db, [id]),
  ]);
  const [row] = rows;
  if (!row) {
    throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${id}`);
  }
  return dbPurchaseToAPI(
    row,
    dataQualities.get(id)!,
    images,
    financialByPurchase.get(id),
  );
};

export type PurchaseLinkIdentity = Pick<
  PurchaseOut,
  "id" | "orderId" | "displayLabel" | "date" | "vendorId" | "vendorName"
>;

/**
 * The canonical identity needed to render a link to a charge.
 *
 * Kept smaller than `getPurchaseByID`: an expense detail already has a separate
 * hover-preview query for the full charge, so loading documents, reconciliation
 * aggregates, and notes just to label its parent link would duplicate work.
 */
export const getPurchaseLinkIdentityByID = async (
  db: Database,
  id: PurchaseId,
): Promise<PurchaseLinkIdentity | null> => {
  const [row] = await getDb(db)
    .select({
      shortcode: purchase.shortcode,
      orderId: purchase.orderId,
      displayLabel: purchase.displayLabel,
      date: purchase.date,
      vendorName: purchaseVendorName,
      vendorShortcode: purchaseVendorShortcode,
    })
    .from(purchase)
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .limit(1);

  return row
    ? {
        id: unsafePurchaseShortcode(row.shortcode),
        orderId: row.orderId,
        displayLabel: row.displayLabel,
        date: row.date,
        vendorId: unsafeVendorShortcode(row.vendorShortcode),
        vendorName: row.vendorName,
      }
    : null;
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

export const reclassifyPurchaseDocument = async (
  db: Database,
  input: ReclassifyPurchaseDocumentInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const id = await resolveOrThrow(db, "purchase", input.purchaseId);
  // `input.imageId` is the public `IMG-` code `PurchaseOut.images[].id` handed
  // back; resolving it here (throwing IMAGE_NOT_FOUND on an unknown code)
  // subsumes the "not a real image" case the join lookup below used to be the
  // only guard against.
  const imageId = await resolveOrThrow(db, "image", input.imageId);
  await withTransaction(db, async (tx) => {
    const before = await tx.query.purchaseImage.findFirst({
      where: and(
        eq(purchaseImage.purchaseId, id),
        eq(purchaseImage.imageId, imageId),
        notDeleted(purchaseImage),
      ),
    });
    if (!before) {
      throw createAppError(
        "IMAGE_NOT_FOUND",
        `Attachment ${input.imageId} is not filed against ${input.purchaseId}.`,
      );
    }
    if (before.documentKind === input.documentKind) return;
    await tx
      .update(purchaseImage)
      .set({ documentKind: input.documentKind, updatedAt: new Date() })
      .where(eq(purchaseImage.id, before.id));
    await tx
      .update(purchase)
      .set({ updatedAt: new Date() })
      .where(and(eq(purchase.id, id), notDeleted(purchase)));
    await logAuditEntry(tx, actor, {
      entityType: "purchase",
      entityId: id,
      action: "update",
      changes: {
        documentKind: {
          from: before.documentKind,
          to: input.documentKind,
        },
      },
    });
  });
  return getPurchaseByID(db, id);
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
  input: { vendorId: VendorId; orderId?: string | null; date: string },
): Promise<PurchaseId> => {
  const orderId = input.orderId?.trim() || null;

  if (orderId === null) {
    const created = await insertWithShortcode(db, "purchase", {
      vendorId: input.vendorId,
      orderId: null,
      date: input.date,
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
      date: input.date,
    }),
  });
  return row.id;
};

export const createPurchase = async (
  db: Database,
  data: PurchaseCreateInput,
  actor: ActorContext,
): Promise<{ output: PurchaseOut; entityId: PurchaseId }> => {
  const id = await withTransaction(db, async (tx) => {
    // Resolving to a LIVE row is the FK-liveness check itself — an FK proves
    // the vendor row exists, not that it's live, but `resolveOrThrow` throws
    // for a soft-deleted one.
    const vendorId = await resolveOrThrow(tx, "vendor", data.vendorId);
    const created = await insertWithShortcode(tx, "purchase", {
      vendorId,
      orderId: data.orderId?.trim() || null,
      displayLabel: data.displayLabel?.trim() || null,
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
  return { output: await getPurchaseByID(db, id), entityId: id };
};

const PURCHASE_AUDIT_FIELDS = [
  "vendorId",
  "orderId",
  "displayLabel",
  "date",
  "statedTotal",
  "notes",
] as const;

export const updatePurchase = async (
  db: Database,
  input: PurchaseUpdateInput,
  actor: ActorContext,
): Promise<{
  output: PurchaseOut;
  entityId: PurchaseId;
  /** R2 objects `removeImageIds` reaped; drop them after this commit. */
  detachedImageKeys: string[];
}> => {
  const { data } = input;
  const id = await resolveOrThrow(db, "purchase", input.id);
  let detachedImageKeys: string[] = [];

  await withTransaction(db, async (tx) => {
    const before = await tx.query.purchase.findFirst({
      where: and(eq(purchase.id, id), notDeleted(purchase)),
    });
    if (!before) {
      throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${id}`);
    }

    // Resolving to a LIVE row is the liveness check itself.
    let resolvedVendorId: VendorId | undefined;
    if (data.vendorId !== undefined) {
      resolvedVendorId = await resolveOrThrow(tx, "vendor", data.vendorId);
    }

    // This is the one writer that can move BOTH halves of the partial-unique
    // `(vendorId, orderId)` key, so it is the one that can collide. Two charges
    // legitimately share an order id across vendors — order ids are only unique
    // per vendor (Tool Nirvana's "#11325") — so moving a charge to a vendor that
    // already holds that order id raises 23505. Nothing maps that to an AppError,
    // so it surfaced as an untyped 500 instead of the message
    // `renameChargeOrderId` was built to give. Pre-checked with a SELECT for the
    // same reason it is there: a failed statement poisons the transaction.
    const nextVendorId = resolvedVendorId ?? before.vendorId;
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
          `Another purchase for this vendor already carries order id ${nextOrderId}. Merge the two purchases instead of moving this one onto it.`,
        );
      }
    }

    detachedImageKeys = await syncPurchaseImages(
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
        vendorId: resolvedVendorId,
        orderId:
          data.orderId === undefined ? undefined : data.orderId?.trim() || null,
        displayLabel:
          data.displayLabel === undefined
            ? undefined
            : data.displayLabel?.trim() || null,
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

  return {
    output: await getPurchaseByID(db, id),
    entityId: id,
    detachedImageKeys,
  };
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
  const purchaseId = await resolveOrThrow(db, "purchase", input.purchaseId);

  // Resolve INCLUDING soft-deleted rows. A live-only lookup here would throw
  // EXPENSE_NOT_FOUND for a tombstoned line, but this function's contract is to
  // skip a selection with no live lines silently (see `before.length === 0`
  // below) — only a code that names nothing at all is an error.
  const resolvedExpenses = await resolveShortcodes(db, input.expenseIds);
  const missingExpenses = input.expenseIds.filter(
    (code) => resolvedExpenses.get(code)?.entity !== "expense",
  );
  if (missingExpenses.length > 0) {
    throw createAppError(
      "EXPENSE_NOT_FOUND",
      `Expense(s) not found: ${missingExpenses.join(", ")}`,
    );
  }
  const expenseIds = input.expenseIds.map((code) =>
    unsafeExpenseId(resolvedExpenses.get(code)?.id ?? ""),
  );

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
      columns: { id: true, productId: true, purchaseId: true },
    });
    if (before.length === 0) return;

    await tx
      .update(expense)
      .set({ purchaseId })
      .where(and(inArray(expense.id, expenseIds), notDeleted(expense)));

    await touchDataQualityTargets(tx, {
      productIds: before
        .map((row) => row.productId)
        .filter((value): value is ProductId => value !== null),
      purchaseIds: [
        purchaseId,
        ...before
          .map((row) => row.purchaseId)
          .filter((value): value is PurchaseId => value !== null),
      ],
    });

    await logAuditEntries(
      tx,
      actor,
      before.flatMap((row) => {
        const changes = computeChanges(row, { ...row, purchaseId }, [
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
 * the point: a combo-kit purchase is one vendor event whose saw half is `tools` and
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
): Promise<{
  items: ExpenseOut[];
  priceAffectedProductIds: ProductId[];
}> => {
  const { attributionPolicy, parts } = input;
  const expenseId = await resolveOrThrow(db, "expense", input.expenseId);

  const { createdIds, priceAffectedProductIds } = await withTransaction(
    db,
    async (tx) => {
      const original = await tx.query.expense.findFirst({
        where: and(eq(expense.id, expenseId), notDeleted(expense)),
      });
      if (!original) {
        throw createAppError(
          "EXPENSE_NOT_FOUND",
          `Expense not found: ${expenseId}`,
        );
      }

      // Ensure the row HAS a Purchase before splitting: parts of one vendor event must
      // share one parent, and a vendorless row has none yet. Nothing to invent a
      // vendor from, so this is the one case a split can't proceed.
      const chargeId = original.purchaseId;
      if (!chargeId) {
        throw createAppError(
          "PURCHASE_NOT_FOUND",
          `Cannot split an expense with no purchase attached (${expenseId}) — record its vendor first.`,
        );
      }

      const [originalAttributions, sourceRefs] = await Promise.all([
        tx
          .select({
            role: expenseAttribution.role,
            ledgerPartyId: expenseAttribution.ledgerPartyId,
            weight: expenseAttribution.weight,
          })
          .from(expenseAttribution)
          .where(
            and(
              eq(expenseAttribution.expenseId, expenseId),
              notDeleted(expenseAttribution),
            ),
          ),
        tx
          .select({ id: ledgerSourceClaim.id })
          .from(ledgerSourceClaim)
          .where(
            and(
              eq(ledgerSourceClaim.expenseId, expenseId),
              notDeleted(ledgerSourceClaim),
            ),
          )
          .limit(1),
      ]);

      if (sourceRefs.length > 0) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Imported Expenses cannot be split because one external source row cannot identify multiple replacement Expenses.",
        );
      }
      if (originalAttributions.length > 0 && attributionPolicy === undefined) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Choose whether the replacement Expenses inherit or clear the original household attribution.",
        );
      }

      const productShortcodes = parts
        .map((part) => part.productId)
        .filter((code): code is NonNullable<typeof code> => code !== null);
      const resolvedProductIds = await resolveAllOrThrow(
        tx,
        "product",
        productShortcodes,
      );
      const productIds = new Map(
        productShortcodes.map((code, i) => {
          // Non-null: resolveAllOrThrow returns one id per input code, positionally.
          return [code, resolvedProductIds[i]!] as const;
        }),
      );

      const pricingCandidates = uniq(
        [
          original.productId,
          ...parts.map((part) =>
            part.productId ? (productIds.get(part.productId) ?? null) : null,
          ),
        ].filter((value): value is ProductId => value !== null),
      );
      const pricesBefore = await loadEffectiveProductPricesById(
        tx,
        pricingCandidates,
      );

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
        const productId = part.productId
          ? (productIds.get(part.productId) ?? null)
          : null;
        const explicitProjectId = part.projectId
          ? await resolveOrThrow(tx, "project", part.projectId)
          : null;
        // Same import-time triage default `createExpense` applies: a split
        // part carrying a food productId with no explicit project lands on
        // Household rather than minting an untriaged line. See
        // `resolveDefaultProjectId`'s doc comment for why updates/moves skip it.
        const projectId = await resolveDefaultProjectId(tx, {
          projectId: explicitProjectId,
          productId,
        });
        const lineKind =
          part.lineKind ?? inferExpenseLineKind({ name: part.name, productId });
        if (lineKind !== "principal" && productId !== null) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Only principal Expenses may link a Product.",
          );
        }
        if (part.productQuantity !== null && productId === null) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Product quantity requires a linked product.",
          );
        }
        assertQuantitySignMatchesCost(part.cost, part.productQuantity);
        const row = await insertWithShortcode(tx, "expense", {
          name: part.name,
          cost: part.cost,
          date: original.date,
          lineKind,
          costType: part.costType,
          trade: part.trade,
          url: original.url,
          notes: part.notes === undefined ? original.notes : part.notes,
          future: original.future,
          projectId,
          productId,
          productQuantity: part.productQuantity,
          purchaseId: chargeId,
        });
        inserted.push(row.id);

        if (
          attributionPolicy === "inherit" &&
          originalAttributions.length > 0
        ) {
          await tx.insert(expenseAttribution).values(
            originalAttributions.map((attribution) => ({
              expenseId: row.id,
              role: attribution.role,
              ledgerPartyId: attribution.ledgerPartyId,
              weight: attribution.weight,
            })),
          );
        }
      }

      // NO `notDeleted` guard here, deliberately. The `original` read above uses
      // one but takes no `FOR UPDATE`, so adding the predicate would turn a
      // stomping update into a silent 0-row no-op while the N part rows are
      // still inserted and a delete entry is still logged for a row this
      // transaction didn't delete. Leave it stomping.
      await tx
        .update(expense)
        .set({ deletedAt: new Date() })
        .where(eq(expense.id, expenseId));

      const auditEntries: AuditEntryInput[] = inserted.map((id) => ({
        entityType: "expense" as const,
        entityId: id,
        action: "create" as const,
      }));
      await cascadeRemoval(tx, {
        entity: "expense",
        ids: [expenseId],
        audit: { into: auditEntries },
      });

      await touchDataQualityTargets(tx, {
        productIds: [
          original.productId,
          ...parts.map((part) =>
            part.productId ? (productIds.get(part.productId) ?? null) : null,
          ),
        ].filter((value): value is ProductId => value !== null),
        purchaseIds: [chargeId],
      });

      await logAuditEntries(tx, actor, auditEntries);

      const pricesAfter = await loadEffectiveProductPricesById(
        tx,
        pricingCandidates,
      );
      const priceAffectedProductIds = pricingCandidates.filter(
        (productId) =>
          pricesBefore.get(productId) !== pricesAfter.get(productId),
      );
      for (const productId of priceAffectedProductIds) {
        await syncInventoryValuationsForProduct(tx, productId);
      }

      return { createdIds: inserted, priceAffectedProductIds };
    },
  );

  const rows = await getDb(db).query.expense.findMany({
    where: and(inArray(expense.id, createdIds), notDeleted(expense)),
    ...relations.expense.withProject,
  });
  return { items: rows.map(dbExpenseToAPI), priceAffectedProductIds };
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
  // Purchase-level vendor truth has to come along, not just the lines and documents.
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
      displayLabel: purchase.displayLabel,
      notes: purchase.notes,
      date: purchase.date,
    })
    .from(purchase)
    .where(eq(purchase.id, deadId))
    .limit(1);
  const [survivor] = await tx
    .select({
      statedTotal: purchase.statedTotal,
      displayLabel: purchase.displayLabel,
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
    displayLabel:
      survivor?.displayLabel == null && dead?.displayLabel != null
        ? dead.displayLabel
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

  // `repointEdge` returns the ids it moved, so the audit rows come from the
  // update itself rather than a separate pre-select that could drift from it.
  const moved = await repointEdge(tx, "purchase", "Expense.purchaseId", {
    from: [deadId],
    to: survivorId,
    liveOnly: true,
  });

  await logAuditEntries(
    tx,
    actor,
    moved.map((id) => ({
      entityType: "expense" as const,
      entityId: id,
      action: "update" as const,
      changes: { purchaseId: { from: deadId, to: survivorId } },
    })),
  );

  // Settlement allocations move onto the survivor, and where BOTH purchases held
  // a slice of the SAME transaction the two slices are SUMMED into one row.
  //
  // ⚠️ `onConflictDoNothing` — what the images and product links below correctly
  // use — is exactly wrong here and must never be copied onto this edge. An
  // allocation carries an amount, so skipping the duplicate would destroy that
  // money-shaped evidence and leave the transaction's allocations no longer
  // summing to its amount.
  //
  // The mirror column is deliberately NOT repointed. It is re-derived from the
  // surviving allocations instead, because a transaction holding a slice of both
  // purchases collapses to a single slice on the survivor and becomes singly
  // linked again — a null→non-null move `repointEdge` could never produce.
  const movingAllocations =
    await tx.query.financialTransactionAllocation.findMany({
      where: and(
        eq(financialTransactionAllocation.purchaseId, deadId),
        notDeleted(financialTransactionAllocation),
      ),
      columns: { id: true, transactionId: true, amount: true },
    });
  const survivorAllocations =
    await tx.query.financialTransactionAllocation.findMany({
      where: and(
        eq(financialTransactionAllocation.purchaseId, survivorId),
        notDeleted(financialTransactionAllocation),
      ),
      columns: { id: true, transactionId: true, amount: true },
    });
  const survivorByTransaction = new Map(
    survivorAllocations.map((row) => [row.transactionId, row]),
  );
  const allocationTransactionIds = uniq(
    movingAllocations.map((row) => row.transactionId),
  );
  const allocationsBefore = await readAllocations(tx, allocationTransactionIds);

  for (const moving of movingAllocations) {
    const collision = survivorByTransaction.get(moving.transactionId);
    if (collision) {
      // Sum, then retire the absorbed row. Order matters: the partial unique
      // index on (transactionId, purchaseId) would abort the merge if the
      // repoint below ran while both rows were still live.
      await tx
        .update(financialTransactionAllocation)
        .set({
          amount: Number(collision.amount) + Number(moving.amount),
          updatedAt: new Date(),
        })
        .where(eq(financialTransactionAllocation.id, collision.id));
      await tx
        .update(financialTransactionAllocation)
        .set({ deletedAt: new Date() })
        .where(eq(financialTransactionAllocation.id, moving.id));
      continue;
    }
    // Repoint in place rather than insert-then-delete: it is the same slice, so
    // its row id and createdAt should survive the move.
    await tx
      .update(financialTransactionAllocation)
      .set({ purchaseId: survivorId, updatedAt: new Date() })
      .where(eq(financialTransactionAllocation.id, moving.id));
  }

  // Audit entries, the mirror re-derivation, and the data-quality touch all come
  // from the shared core rather than being written here.
  //
  // Its `changedTransactionIds` are deliberately unused: unlike the delete path,
  // which returns them for the router to refresh after commit, a purchase merge
  // has never refreshed its transactions' embeddings. Both purchases share a
  // vendor here, so the embedded vendor/order text rarely moves — but if that is
  // ever wired up, this is where the ids come from.
  await applyAllocationChanges(tx, {
    transactionIds: allocationTransactionIds,
    before: allocationsBefore,
    actor,
  });

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

  // Product links follow their charge for the same reason, and need the same
  // `onConflictDoNothing`: the partial-unique (purchaseId, productId) would
  // abort the merge when both charges already name the same Product.
  const movingProducts = await tx.query.purchaseProduct.findMany({
    where: and(
      eq(purchaseProduct.purchaseId, deadId),
      notDeleted(purchaseProduct),
    ),
    columns: { productId: true },
  });
  if (movingProducts.length > 0) {
    await tx
      .insert(purchaseProduct)
      .values(
        movingProducts.map((row) => ({
          purchaseId: survivorId,
          productId: row.productId,
        })),
      )
      .onConflictDoNothing();
    await tx
      .update(purchaseProduct)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(purchaseProduct.purchaseId, deadId),
          notDeleted(purchaseProduct),
        ),
      );
  }

  // Evidence-changing invariant: this fold just re-pointed Expenses,
  // FinancialTransactions, and documents onto the survivor — the exact class
  // of change `linkExpensesToPurchase` and `splitExpense` already invalidate
  // stored exceptions for. Bumping `updatedAt` makes an exception's
  // `check:updatedAt` fingerprint stop matching, so a stale
  // `paperwork_mismatch`/`settlement_reference`/etc. exception reports STALE
  // instead of silently staying "active" against evidence that moved out from
  // under it. Unconditional — even when `carried` above was empty (both
  // purchases already fully populated, so no column changed on the survivor
  // row itself), the lines still moved, which is real evidence movement on its
  // own and must still invalidate the survivor's exceptions. Also touches the
  // products behind any moved expense: a purchase-level check can read through
  // to a product (`amazon_asin`'s vendor lookup), and a product-level
  // exception is fingerprinted against `Product.updatedAt`, not
  // `Purchase.updatedAt`, so it needs its own bump.
  const movedExpenseProducts =
    moved.length > 0
      ? await tx.query.expense.findMany({
          where: inArray(expense.id, moved.map(unsafeExpenseId)),
          columns: { productId: true },
        })
      : [];
  await touchDataQualityTargets(tx, {
    purchaseIds: [survivorId],
    productIds: movedExpenseProducts
      .map((row) => row.productId)
      .filter((value): value is ProductId => value !== null),
  });

  // Soft-delete the dead charge, cascade its search embedding, and write the
  // trail — one call, so the embedding cascade can't be dropped (see
  // `finalizeMerge`). The charge gets a `delete` entry and the survivor an
  // `update` naming what it absorbed, so a fold is reconstructible from the log
  // rather than inferable only from the absence of a row.
  await finalizeMerge(tx, {
    entity: "purchase",
    table: purchase,
    keepId: survivorId,
    loserIds: [deadId],
    removal: "soft",
    actor,
    survivorChanges: {
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
  });
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
): Promise<MergePurchasesOut> => {
  const { keepId, loserIds: losers } = await resolveMergeTargets(db, {
    entity: "purchase",
    keepId: input.keepId,
    mergeIds: input.mergeIds,
  });
  let mergedCount = 0;
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
          `Cannot merge purchases across vendors: ${violation.offendingIds.join(", ")} belong to a different vendor than ${keepId}.`,
        );
      }
      throw createAppError(
        "PURCHASE_MERGE_ORDER_COLLISION",
        `Cannot merge purchases that each carry an order id (${violation.orderIds.join(", ")}) — those are separate transactions.`,
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
    // MEASURED, not `losers.length`: this statement is the one that actually
    // removes them, and the `foldChargeInto` calls below re-issue the same
    // soft-delete as a no-op, so `finalizeMerge` there reports 0.
    const removed = await tx
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(and(inArray(purchase.id, losers), notDeleted(purchase)))
      .returning({ id: purchase.id });
    mergedCount = removed.length;

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
    ]);
  });

  return {
    purchase: await getPurchaseByID(db, keepId),
    mergeSummary: {
      keepId: input.keepId,
      deletedIds: input.mergeIds.filter((code) => code !== input.keepId),
      merged: mergedCount,
    },
  };
};

/**
 * Soft-delete charges.
 *
 * Removal-path invariant (root CLAUDE.md, guard-enforced): the same transaction
 * soft-deletes the Purchase's `PurchaseImage` rows and NULLS `purchaseId` on its
 * expenses. Nulling rather than cascading is the point — an expense is the money,
 * and deleting a charge must never delete spend. Those rows fall back to reading
 * as "no vendor recorded", which is exactly what they are once the charge is gone.
 *
 * Purchase embeddings are retired in the same transaction. Callers refresh the
 * detached expenses/financial transactions after the mutation commits.
 */
const deletePurchasesWithPolicy = async (
  db: Database,
  shortcodes: PurchaseShortcode[],
  actor: ActorContext,
  policy: "detach-references" | "require-empty",
): Promise<{
  expenseIds: ExpenseId[];
  financialTransactionIds: FinancialTransactionId[];
  /** R2 objects the image cascade reaped; drop them after this commit. */
  detachedImageKeys: string[];
  /** Rows actually removed, measured by `removeEntity` rather than assumed. */
  deleted: number;
}> => {
  if (shortcodes.length === 0)
    return {
      expenseIds: [],
      financialTransactionIds: [],
      detachedImageKeys: [],
      deleted: 0,
    };

  const ids = await resolveAllOrThrow(db, "purchase", shortcodes);

  return withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, purchase, ids, "Purchase");

    // Detaching a line is an audited change to its `purchaseId`, same as every
    // other writer of that column. Without these rows, spend silently loses its
    // vendor attribution with only the charge's own `delete` entry to hint at it —
    // and since `vendor`/`orderId` resolve THROUGH this column, the row's whole
    // provenance goes with it.
    const detaching = await tx
      .select({ id: expense.id, purchaseId: expense.purchaseId })
      .from(expense)
      .where(and(inArray(expense.purchaseId, ids), notDeleted(expense)));

    // Every transaction holding a slice of any purchase being deleted — the
    // mirror alone would miss a split one, whose mirror is NULL.
    const affectedTransactionIds = await transactionIdsAllocatedTo(tx, ids);

    if (
      policy === "require-empty" &&
      (detaching.length > 0 || affectedTransactionIds.length > 0)
    ) {
      // `detaching` already carries `purchaseId` per row, so the refusal can
      // name WHICH purchases are non-empty and with how many expenses. The old
      // message could not: one non-empty purchase anywhere in the batch refused
      // every purchase in the call and left the caller to guess which.
      const expensesByPurchase: Record<string, number> = {};
      for (const row of detaching) {
        if (row.purchaseId)
          expensesByPurchase[row.purchaseId] =
            (expensesByPurchase[row.purchaseId] ?? 0) + 1;
      }
      const blockedDetail = Object.entries(expensesByPurchase)
        .map(([purchaseId, n]) => `${purchaseId} (${n} expense(s))`)
        .join(", ");
      // Settlement allocations are keyed by transaction, not by purchase, so
      // that half stays a count — attributing a split allocation back to one
      // purchase is exactly the ambiguity `transactionIdsAllocatedTo` exists to
      // avoid asserting.
      const transactionDetail =
        affectedTransactionIds.length > 0
          ? `${affectedTransactionIds.length} linked Financial Transaction(s) hold settlement allocations`
          : "";
      throw createAppError(
        "PURCHASE_NOT_EMPTY",
        [
          "Cannot delete non-empty Purchases through MCP.",
          blockedDetail && `Still carrying expenses: ${blockedDetail}.`,
          transactionDetail && `${transactionDetail}.`,
          "Delete linked Expenses first and unlink or delete linked Financial Transactions and their settlement allocations.",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    if (policy === "detach-references") {
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

      // Drop ALL slices of every affected transaction, not just the slices
      // belonging to the purchases being deleted. A partial allocation set is
      // not a legal state — a transaction has either none, or a set summing to
      // its amount — whereas zero is legal, meaningful and re-enterable
      // ("unlinked evidence"). So a split transaction losing one of its two
      // purchases reverts entirely to unlinked rather than being left standing
      // in permanent violation. For the ordinary single-allocation transaction
      // this is exactly equivalent to detaching it.
      if (affectedTransactionIds.length > 0) {
        const allocationsBefore = await readAllocations(
          tx,
          affectedTransactionIds,
        );
        await tx
          .update(financialTransactionAllocation)
          .set({ deletedAt: new Date() })
          .where(
            and(
              inArray(
                financialTransactionAllocation.transactionId,
                affectedTransactionIds,
              ),
              notDeleted(financialTransactionAllocation),
            ),
          );
        await applyAllocationChanges(tx, {
          transactionIds: affectedTransactionIds,
          before: allocationsBefore,
          actor,
        });
      }
    }

    // `{actor}`, not a caller-owned buffer: the detach `update` entries above
    // were already flushed, and the delete entries must follow them.
    const { detachedImageKeys, deleted } = await removeEntity(tx, {
      entity: "purchase",
      ids,
      removal: "soft",
      actor,
      children: [
        {
          table: purchaseProduct,
          parentColumns: [purchaseProduct.purchaseId],
          auditKey: "cascadedPurchaseProducts",
        },
        {
          table: purchaseImage,
          parentColumns: [purchaseImage.purchaseId],
          auditKey: "cascadedPurchaseImages",
        },
      ],
    });

    return {
      expenseIds: detaching.map((row) => row.id),
      // Union of the mirror and the allocations: a split transaction's mirror is
      // NULL, so the mirror alone would leave its embedding stale — that text
      // carries the vendor and order id resolved through its purchase.
      financialTransactionIds: affectedTransactionIds,
      detachedImageKeys,
      deleted,
    };
  });
};

export const deletePurchases = async (
  db: Database,
  shortcodes: PurchaseShortcode[],
  actor: ActorContext,
) => deletePurchasesWithPolicy(db, shortcodes, actor, "detach-references");

/**
 * Agent-safe deletion for Purchase headers that carry no live spend or
 * settlement evidence. The reference check and soft delete happen under the
 * same Purchase row locks, so a clean preview is never trusted as a lock.
 */
export const deleteEmptyPurchases = async (
  db: Database,
  shortcodes: PurchaseShortcode[],
  actor: ActorContext,
): Promise<{
  shortcodes: PurchaseShortcode[];
  detachedImageKeys: string[];
}> => {
  const { detachedImageKeys } = await deletePurchasesWithPolicy(
    db,
    shortcodes,
    actor,
    "require-empty",
  );
  return { shortcodes, detachedImageKeys };
};

/**
 * What `deletePurchases` would do to the given charges, without doing it.
 *
 * Reads the SAME `PURCHASE_DELETE_EDGE_POLICY` this file's mutation
 * implements. Both edges are non-blocking (`detach`/`soft-delete`), so this
 * preview has only `changes` — nothing refuses a purchase delete. Embedding
 * cleanup is an implementation invariant rather than a user-visible impact.
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
    impact({
      disposition: PURCHASE_DELETE_EDGE_POLICY["PurchaseProduct.purchaseId"],
      edgeKey: "PurchaseProduct.purchaseId",
      label: "product links removed",
      byTargetId: await countByTarget(
        dbClient,
        purchaseProduct,
        purchaseProduct.purchaseId,
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
  // Refuses exactly where the mutation refuses — see
  // `assertDistinctMergeTargets` for why the silent filter this replaces made
  // preview and mutation agree on the wrong answer.
  assertDistinctMergeTargets("purchase", keepId, input.mergeIds);
  const losers = input.mergeIds;
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
              "The keeper purchase doesn't exist or has already been deleted.",
          },
          label: "missing keeper purchase",
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
                "Purchases across different vendors can't be merged — a merge re-points a purchase's expenses and documents, never its vendor.",
            },
            label: "purchases belonging to a different vendor",
            byTargetId: Object.fromEntries(
              violation.offendingIds.map((id) => [id, 1]),
            ),
          })
        : impact({
            disposition: {
              code: "block-order-collision-merge",
              effect: "block",
              description:
                "More than one purchase in this merge set carries its own order id — those are separate transactions and can't be merged.",
            },
            label: "purchases each carrying an order id",
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
    impact({
      disposition: PURCHASE_MERGE_EDGE_POLICY["PurchaseProduct.purchaseId"],
      edgeKey: "PurchaseProduct.purchaseId",
      label: "product links moved and deduplicated",
      byTargetId: await countByTarget(
        dbClient,
        purchaseProduct,
        purchaseProduct.purchaseId,
        losers,
      ),
    }),
    impact({
      disposition:
        PURCHASE_MERGE_EDGE_POLICY["FinancialTransactionAllocation.purchaseId"],
      edgeKey: "FinancialTransactionAllocation.purchaseId",
      label: "settlement allocations moved",
      byTargetId: await countByTarget(
        dbClient,
        financialTransactionAllocation,
        financialTransactionAllocation.purchaseId,
        losers,
      ),
    }),
  ]);

  const sideEffects = present([
    impact({
      disposition: {
        code: "soft-delete-source-purchase",
        effect: "soft-delete",
        description: "The merged-away purchases are soft-deleted.",
      },
      label: "source purchases removed",
      byTargetId: Object.fromEntries(losers.map((id) => [id, 1])),
    }),
  ]);

  return { blockers, changes, sideEffects };
};
