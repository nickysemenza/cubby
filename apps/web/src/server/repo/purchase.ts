import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { inferExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  type ExpenseId,
  type ProductId,
  type PurchaseId,
  type PurchaseShortcode,
  parseEntityId,
  parseShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { ExpenseOut } from "@cubby/schemas/project";
import type {
  LinkExpensesToPurchaseInput,
  MergePurchasesInput,
  MergePurchasesOut,
  PurchaseCreateInput,
  PurchaseFilters,
  PurchaseListItemOut,
  PurchaseOut,
  PurchaseUpdateData,
  ReclassifyPurchaseDocumentInput,
  SplitExpenseInput,
} from "@cubby/schemas/purchase";
import {
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
} from "@cubby/schemas/purchase";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";
import { parseShortcode } from "@cubby/shared";
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

import { purchaseLabel } from "~/lib/purchase-label";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  entityAttachment,
  expense,
  expenseAttribution,
  financialTransactionAllocation,
  image,
  runEvidence,
  runTarget,
  importSourceClaim,
  ledgerSourceClaim,
  purchase,
  purchasePaymentEvidence,
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
  gapCondition,
  loadDataQualities,
  touchDataQualityTargets,
} from "~/server/repo/data-quality";
import {
  buildPartialUpdateValues,
  correlated,
  eqAny,
  getDb,
  imageJoinBindings,
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  presenceCondition,
  relations,
  syncEntityImages,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import {
  assertQuantitySignMatchesCost,
  dbExpenseToAPI,
} from "~/server/repo/expense/helpers";
import {
  calculateFinancialReconciliation,
  postedRefundTotalSql,
  settleableExpenseTotalSql,
  settleableUnpricedExpenseCountSql,
} from "~/server/repo/financial-reconciliation";
import {
  applyAllocationChanges,
  readAllocations,
  transactionIdsAllocatedTo,
} from "~/server/repo/financial-transaction-allocations";
import { displayableImageSql } from "~/server/repo/image-displayability";
import { listScaffold } from "~/server/repo/list-scaffold";
import {
  finalizeMerge,
  repointEdge,
  resolveMergeTargets,
} from "~/server/repo/merge";
import { syncChangedEffectivePrices } from "~/server/repo/product/price-sync";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import {
  emptyPurchaseFinancialAggregate,
  loadPurchaseFinancialAggregates,
  type PurchaseFinancialAggregate,
} from "~/server/repo/purchase-financial-aggregates";
import { relatedWhereConditions } from "~/server/repo/related-view";
/** Purchase repository: one vendor event per row; Expense is the authoritative spend ledger. */
import { deleteByPolicy } from "~/server/repo/removal";
import { cascadeRemoval } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveLiveShortcode,
  resolveOrThrow,
  resolveShortcodes,
} from "~/server/repo/shortcode-resolver";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
  expenseInheritanceReadExtras,
  validateExpenseInheritance,
} from "./expense-inheritance";
import { hydrateExpenseProjectAllocations } from "./expense-project-allocation";
import { validateLiveEffectiveTrades } from "./inheritance-validation";

export const PURCHASE_DELETE_EDGE_POLICY = {
  "RunTarget.purchaseId": {
    code: "preserve-targeted-import-history",
    effect: "preserve",
    description:
      "Targeted validation history keeps the deleted purchase tombstone.",
  },
  "ImportSourceClaim.purchaseId": {
    code: "clear-import-claim",
    effect: "detach",
    description:
      "Source claims stay as replay records but stop pointing at the deleted purchase, so the source can be imported again.",
  },
  "PurchasePaymentEvidence.purchaseId": {
    code: "delete-payment-evidence",
    effect: "hard-delete",
    description:
      "Captured payment evidence has no meaning without its purchase.",
  },
  "Expense.purchaseId": {
    code: "clear-live-fk-with-audit",
    effect: "detach",
    description:
      "Deleting a purchase nulls its expenses' purchaseId rather than deleting them — an expense is the money, and deleting a purchase must never delete spend. Each detach is logged to the audit trail.",
  },
  "EntityAttachment.subjectEntityId": {
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
  "RunTarget.purchaseId": {
    code: "repoint-targeted-import-history",
    effect: "repoint",
    description: "Targeted validation history follows the surviving purchase.",
  },
  "ImportSourceClaim.purchaseId": {
    code: "repoint-import-claim",
    effect: "repoint",
    description: "Source claims follow the surviving purchase.",
  },
  "PurchasePaymentEvidence.purchaseId": {
    code: "repoint-payment-evidence",
    effect: "repoint",
    description: "Captured payment evidence follows the surviving purchase.",
  },
  "Expense.purchaseId": {
    code: "repoint-live-fk-with-audit",
    effect: "repoint",
    description:
      "Merging a purchase re-points its expenses onto the surviving purchase, logged to the audit trail.",
  },
  "EntityAttachment.subjectEntityId": {
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
 * Actual spend is always `SUM(Expense.cost)`, never `statedTotal`. Keep raw SQL
 * fully qualified because Drizzle strips aliases from correlated selections.
 */
const purchaseExpenseCount = correlated<number>(
  `(SELECT count(*)::int FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL)`,
);

const purchaseExpenseTotal = correlated<number>(
  `(SELECT COALESCE(sum(e."cost"::numeric), 0)::double precision FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL)`,
);

const purchaseUnpricedExpenseCount = correlated<number>(
  `(SELECT count(*)::int FROM "Expense" e
     WHERE e."purchaseId" = "Purchase"."id"
       AND e."cost" IS NULL AND e."deletedAt" IS NULL)`,
);

// Settlement compares only incurred spend; future rows cannot have settled.
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
  `(SELECT count(*)::int FROM "EntityAttachment" pi
     JOIN "Image" i ON i."id" = pi."imageId" AND i."deletedAt" IS NULL
     WHERE pi."subjectEntityId" = "Purchase"."id" AND pi."deletedAt" IS NULL)`,
);

const purchaseVendorName = correlated<string | null>(
  `(SELECT v."name" FROM "Vendor" v
     WHERE v."id" = "Purchase"."vendorId" AND v."deletedAt" IS NULL)`,
);

// Public shortcodes remain resolvable tombstones after a vendor soft-delete.
const purchaseVendorShortcode = correlated<string>(
  `(SELECT v."shortcode" FROM "Vendor" v WHERE v."id" = "Purchase"."vendorId")`,
);

const purchaseDefaultProjectShortcode = correlated<string | null>(
  `(SELECT p."shortcode" FROM "Project" p WHERE p."id" = "Purchase"."defaultProjectId" AND p."deletedAt" IS NULL)`,
);

const purchaseVendorAccountShortcode = correlated<string | null>(
  `(SELECT va."shortcode" FROM "VendorAccount" va WHERE va."id" = "Purchase"."vendorAccountId" AND va."deletedAt" IS NULL)`,
);

const purchaseVendorOrderUrlTemplate = correlated<string | null>(
  `(SELECT v."orderUrlTemplate" FROM "Vendor" v
     WHERE v."id" = "Purchase"."vendorId" AND v."deletedAt" IS NULL)`,
);

const purchaseVendorLogoKey = sql<string | null>`(
  SELECT logo."key" FROM "Vendor" v
  JOIN "EntityAttachment" logo_att ON logo_att."subjectEntityId" = v."id"
    AND logo_att."role" = 'logo' AND logo_att."deletedAt" IS NULL
  JOIN "Image" logo ON logo."id" = logo_att."imageId"
  WHERE v."id" = ${sql.raw('"Purchase"."vendorId"')}
    AND v."deletedAt" IS NULL
    AND logo."deletedAt" IS NULL
    AND ${displayableImageSql("logo")}
)`;

const purchaseColumns = {
  defaultProjectShortcode: purchaseDefaultProjectShortcode,
  defaultTrade: purchase.defaultTrade,
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
  vendorAccountShortcode: purchaseVendorAccountShortcode,
  vendorOrderUrlTemplate: purchaseVendorOrderUrlTemplate,
  vendorLogoKey: purchaseVendorLogoKey,
  expenseCount: purchaseExpenseCount,
  unpricedExpenseCount: purchaseUnpricedExpenseCount,
  expenseTotal: purchaseExpenseTotal,
  settleableExpenseTotal: purchaseSettleableExpenseTotal,
  settleableUnpricedExpenseCount: purchaseSettleableUnpricedExpenseCount,
  documentCount: purchaseDocumentCount,
} as const;

type PurchaseRow = {
  defaultProjectShortcode: string | null;
  defaultTrade: PurchaseOut["defaultTrade"];
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
  vendorAccountShortcode: string | null;
  vendorOrderUrlTemplate: string | null;
  vendorLogoKey: string | null;
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
  id: parseShortcodeFor("purchase", row.shortcode),
  vendorId: parseShortcodeFor("vendor", row.vendorShortcode),
  vendorAccountId: row.vendorAccountShortcode
    ? parseShortcodeFor("vendorAccount", row.vendorAccountShortcode)
    : null,
  defaultProjectId: row.defaultProjectShortcode
    ? parseShortcodeFor("project", row.defaultProjectShortcode)
    : null,
  defaultTrade: row.defaultTrade,
  orderId: row.orderId,
  displayLabel: row.displayLabel,
  date: row.date,
  statedTotal: row.statedTotal,
  notes: row.notes,
  vendorName: row.vendorName,
  vendorLogo: row.vendorLogoKey
    ? { url: getR2PublicUrl(row.vendorLogoKey) }
    : null,
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
  displayName: purchaseLabel({
    orderId: row.orderId,
    displayLabel: row.displayLabel,
    vendorName: row.vendorName,
    date: row.date,
  }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const loadPurchaseImages = async (
  db: Database | DrizzleTransaction,
  id: PurchaseId,
): Promise<PurchaseOut["images"]> => {
  const rows = await unwrapDb(db)
    .select({
      shortcode: image.shortcode,
      filename: image.filename,
      contentType: image.contentType,
      key: image.key,
      documentKind: entityAttachment.documentKind,
    })
    .from(entityAttachment)
    .innerJoin(image, eq(entityAttachment.imageId, image.id))
    .where(
      and(
        eq(entityAttachment.subjectEntityId, id),
        notDeleted(entityAttachment),
        notDeleted(image),
      ),
    )
    .orderBy(asc(entityAttachment.sortOrder), asc(entityAttachment.createdAt));
  return rows.map(({ shortcode, key, documentKind, ...rest }) => ({
    ...rest,
    // Every Purchase attachment is classified; `other` is the insert default.
    documentKind: documentKind ?? "other",
    id: parseShortcodeFor("image", shortcode),
    key,
    url: getR2PublicUrl(key),
  }));
};

/** Sync purchase documents transactionally with explicit ordering; defer R2 deletion until commit. */
const syncPurchaseImages = async (
  tx: DrizzleTransaction,
  id: PurchaseId,
  pendingImageIds: string[] | undefined,
  removeImageIds: string[] | undefined,
  imageOrder: string[] | undefined,
): Promise<string[]> => {
  const { detachedImageKeys } = await syncEntityImages(
    tx,
    "purchase",
    imageJoinBindings.purchase,
    id,
    { pendingImageIds, removeImageIds, imageOrder },
  );
  return detachedImageKeys;
};

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

const purchaseScaffold = listScaffold("purchase", purchase);

/**
 * The complete WHERE for a purchase list, filters and all.
 *
 * The vendor resolve lives INSIDE rather than being handed in: a caller that
 * passed `undefined` would be restating "with no vendor filter there is no
 * vendor predicate", which is a fact this function derives from
 * `filters.vendorId`. `getEntityCounts` calls it with `{}` for exactly that
 * reason — see the registry in repo/dashboard.ts.
 */
export const buildPurchaseWhereClause = async (
  db: Database | DrizzleTransaction,
  filters: PurchaseFilters,
) => {
  // An unknown code resolves to nothing and so matches nothing, which is what a
  // filter naming a missing vendor should do — not throw. `vendorUuids` alone
  // can't express that: `eqAny([])` is "no constraint" by design (see its doc
  // in database-helpers/query.ts), so a requested-but-unresolved vendor has to
  // become an explicit `sql`false`` here rather than being handed to `eqAny`
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
  // `search` (orderId ∪ displayLabel), `displayLabelSearch`, the
  // `statedTotal` presence and the `date` bounds are declared stored
  // filters — applied by `purchaseScaffold.where` before the conditions below.
  return purchaseScaffold.where(filters, [
    vendorCondition,
    ...relatedWhereConditions("purchase", filters, purchase.id),
    eqAny(purchase.orderId, filters.orderId),
    presenceCondition(purchase.orderId, filters.orderIdPresenceFilter),
    expenseStatusCondition(filters.expenseStatus),
    reconciliationCondition(filters.reconciliation),
    // The canonical settlement worklist: the raw financial mismatch minus an
    // active, evidence-bound exception — exactly the check's gap condition.
    filters.financialReconciliation === "mismatch"
      ? gapCondition("purchase", "settlement_mismatch")
      : undefined,
    documentPresenceCondition(filters.documentPresenceFilter),
    filters.expenseTotalMin !== undefined
      ? sql`${purchaseExpenseCount} > ${purchaseUnpricedExpenseCount} AND ${purchaseExpenseTotal} >= ${filters.expenseTotalMin}`
      : undefined,
    filters.expenseTotalMax !== undefined
      ? sql`${purchaseExpenseCount} > ${purchaseUnpricedExpenseCount} AND ${purchaseExpenseTotal} <= ${filters.expenseTotalMax}`
      : undefined,
  ]);
};

const resolvePurchaseSort = (sort: SortParams) => {
  const dir = sort.direction === "asc" ? asc : desc;
  if (sort.orderBy === "vendorId") return [dir(purchaseVendorName)];
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
): Promise<{ data: PurchaseListItemOut[]; count: number }> => {
  return purchaseScaffold.list(
    db,
    { filters, sorts, pagination, readIntent },
    {
      where: await buildPurchaseWhereClause(db, filters),
      resolveSort: resolvePurchaseSort,
      select: (page) =>
        getDb(db)
          .select(purchaseColumns)
          .from(purchase)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      hydrate: async (rows) => {
        const ids = rows.map((row) => row.id);
        const [financialByPurchase, dataQualities] = await Promise.all([
          loadPurchaseFinancialAggregates(db, ids),
          loadDataQualities(db, "purchase", ids),
        ]);
        return withDisplayImages(db, "purchase", rows, (row) =>
          dbPurchaseToAPI(
            row,
            dataQualities.get(row.id)!,
            [],
            financialByPurchase.get(row.id),
          ),
        );
      },
    },
  );
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
    loadDataQualities(db, "purchase", [id]),
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
        id: parseShortcodeFor("purchase", row.shortcode),
        orderId: row.orderId,
        displayLabel: row.displayLabel,
        date: row.date,
        vendorId: parseShortcodeFor("vendor", row.vendorShortcode),
        vendorName: row.vendorName,
      }
    : null;
};

export const getPurchaseByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<PurchaseOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "purchase");
  return id ? getPurchaseByID(db, parseEntityId("purchase", id)) : null;
};

export const reclassifyPurchaseDocument = async (
  db: Database,
  input: ReclassifyPurchaseDocumentInput,
  actor: ActorContext,
): Promise<PurchaseOut> => {
  const id = await resolveOrThrow(db, "purchase", input.purchaseId);
  const imageId = await resolveOrThrow(db, "image", input.imageId);
  await withTransaction(db, async (tx) => {
    const before = await tx.query.entityAttachment.findFirst({
      where: and(
        eq(entityAttachment.subjectEntityId, id),
        eq(entityAttachment.imageId, imageId),
        notDeleted(entityAttachment),
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
      .update(entityAttachment)
      .set({ documentKind: input.documentKind, updatedAt: new Date() })
      .where(eq(entityAttachment.id, before.id));
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

/** Order IDs are vendor-scoped; never group same-number orders across vendors. */
export const getPurchaseExpenses = async (
  db: Database,
  id: PurchaseId,
): Promise<ExpenseOut[]> => {
  const rows = await getDb(db).query.expense.findMany({
    where: and(eq(expense.purchaseId, id), notDeleted(expense)),
    orderBy: [asc(expense.date), asc(expense.name)],
    extras: expenseInheritanceReadExtras(),
    ...relations.expense.withProject,
  });
  const [hydrated, dataQualities] = await Promise.all([
    hydrateExpenseProjectAllocations(db, rows),
    loadDataQualities(
      db,
      "expense",
      rows.map((row) => row.id),
    ),
  ]);
  // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
  return hydrated.map((row) => dbExpenseToAPI(row, dataQualities.get(row.id)!));
};

/**
 * Import upsert. Null order IDs always create distinct charges; non-null IDs are
 * vendor-scoped and race-safe through the partial unique index.
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
    const vendorId = await resolveOrThrow(tx, "vendor", data.vendorId);
    const vendorAccountId = data.vendorAccountId
      ? await resolveOrThrow(tx, "vendorAccount", data.vendorAccountId)
      : null;
    const created = await insertWithShortcode(tx, "purchase", {
      defaultProjectId: data.defaultProjectId
        ? await resolveOrThrow(tx, "project", data.defaultProjectId)
        : null,
      defaultTrade: data.defaultTrade,
      vendorId,
      vendorAccountId,
      orderId: data.orderId?.trim() || null,
      displayLabel: data.displayLabel?.trim() || null,
      date: data.date,
      statedTotal: data.statedTotal,
      notes: data.notes,
    });
    // Claim uploaded documents in the insert transaction so failure leaves no pending files.
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

const resolvePurchaseDefaultProjectUpdate = async (
  tx: DrizzleTransaction,
  shortcode: string | null | undefined,
) => (shortcode == null ? shortcode : resolveOrThrow(tx, "project", shortcode));

export const updatePurchase = async (
  db: Database,
  shortcode: PurchaseShortcode,
  data: PurchaseUpdateData,
  actor: ActorContext,
): Promise<{
  output: PurchaseOut;
  entityId: PurchaseId;
  /** R2 objects `removeImageIds` reaped; drop them after this commit. */
  detachedImageKeys: string[];
}> => {
  const id = await resolveOrThrow(db, "purchase", shortcode);
  let detachedImageKeys: string[] = [];

  await withTransaction(db, async (tx) => {
    const before = await tx.query.purchase.findFirst({
      where: and(eq(purchase.id, id), notDeleted(purchase)),
    });
    if (!before) {
      throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${id}`);
    }

    let resolvedVendorId: VendorId | undefined;
    if (data.vendorId !== undefined) {
      resolvedVendorId = await resolveOrThrow(tx, "vendor", data.vendorId);
    }
    const resolvedVendorAccountId =
      data.vendorAccountId === undefined
        ? undefined
        : data.vendorAccountId === null
          ? null
          : await resolveOrThrow(tx, "vendorAccount", data.vendorAccountId);

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
        vendorAccountId: resolvedVendorAccountId,
        defaultProjectId: await resolvePurchaseDefaultProjectUpdate(
          tx,
          data.defaultProjectId,
        ),
        defaultTrade: data.defaultTrade,
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

    await validatePurchaseItemInheritance(tx, [id]);
    await validateLiveEffectiveTrades(tx);

    const changes = computeChanges(before, after, [
      ...entityFieldModels.purchase.audit,
    ]);
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
  const resolvedExpense = (code: string) => {
    const parsed = parseShortcode(code);
    return parsed?.type === "expense"
      ? resolvedExpenses.get(parsed.shortcode)
      : undefined;
  };
  const missingExpenses = input.expenseIds.filter(
    (code) => resolvedExpense(code)?.entity !== "expense",
  );
  if (missingExpenses.length > 0) {
    throw createAppError(
      "EXPENSE_NOT_FOUND",
      `Expense(s) not found: ${missingExpenses.join(", ")}`,
    );
  }
  const expenseIds = input.expenseIds.map((code) => {
    const ref = resolvedExpense(code);
    if (ref?.entity !== "expense") {
      throw createAppError("EXPENSE_NOT_FOUND", `Expense not found: ${code}`);
    }
    return ref.id;
  });

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

    await validatePurchaseItemInheritance(tx, [purchaseId]);

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

/** A split replaces one ledger amount with parts that conserve its exact cents. */
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

      if (
        original.cost !== null &&
        (parts.some((part) => part.cost === null) ||
          parts.reduce(
            (sum, part) => sum + Math.round((part.cost ?? 0) * 100),
            0,
          ) !== Math.round(original.cost * 100))
      ) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Split parts must conserve the original expense amount exactly.",
        );
      }
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

      const productShortcodes = uniq(
        parts
          .map((part) => part.productId)
          .filter((code): code is NonNullable<typeof code> => code !== null),
      );
      const resolvedProductIds = await resolveAllOrThrow(
        tx,
        "product",
        productShortcodes,
      );
      if (resolvedProductIds.length !== productShortcodes.length) {
        throw new Error("Product shortcode resolution lost its correlation");
      }
      const productIds = new Map<
        (typeof productShortcodes)[number],
        ProductId
      >();
      productShortcodes.forEach((code, index) => {
        const resolvedId = resolvedProductIds[index];
        if (!resolvedId) {
          throw new Error(`Product shortcode resolution lost ${code}`);
        }
        productIds.set(code, resolvedId);
      });

      const projectShortcodes = uniq(
        parts
          .map((part) => part.projectId)
          .filter((code): code is NonNullable<typeof code> => code !== null),
      );
      const resolvedProjectIds = await resolveAllOrThrow(
        tx,
        "project",
        projectShortcodes,
      );
      if (resolvedProjectIds.length !== projectShortcodes.length) {
        throw new Error("Project shortcode resolution lost its correlation");
      }
      const explicitProjectIds = new Map<
        (typeof projectShortcodes)[number],
        (typeof resolvedProjectIds)[number]
      >();
      projectShortcodes.forEach((code, index) => {
        const resolvedId = resolvedProjectIds[index];
        if (!resolvedId) {
          throw new Error(`Project shortcode resolution lost ${code}`);
        }
        explicitProjectIds.set(code, resolvedId);
      });
      const partProductIds = parts.map((part) => {
        if (!part.productId) return null;
        const productId = productIds.get(part.productId);
        if (!productId) {
          throw new Error(
            `Product shortcode resolution lost ${part.productId}`,
          );
        }
        return productId;
      });
      const projectIds = parts.map((part) => {
        const projectId = part.projectId
          ? explicitProjectIds.get(part.projectId)
          : null;
        if (projectId === undefined) {
          throw new Error(
            `Project shortcode resolution lost ${String(part.projectId)}`,
          );
        }
        return projectId;
      });
      if (projectIds.length !== parts.length) {
        throw new Error("Default project resolution lost its correlation");
      }
      const preparedParts = parts.map((part, index) => {
        const productId = partProductIds[index] ?? null;
        const projectId = projectIds[index];
        if (projectId === undefined) {
          throw new Error(
            `Default project resolution lost part ${String(index + 1)}`,
          );
        }
        const lineKind =
          part.lineKind ?? inferExpenseLineKind({ name: part.name, productId });
        if (lineKind !== "principal" && productId !== null) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Only principal Expenses may link a Product. For a disposal or write-off, use lineKind=principal, cost=0, and a negative productQuantity; use other_adjustment only for purchase-level amounts with no Product.",
          );
        }
        if (part.productQuantity !== null && productId === null) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Product quantity requires a linked product.",
          );
        }
        assertQuantitySignMatchesCost(part.cost, part.productQuantity);
        return {
          part,
          productId,
          projectId,
          lineKind,
        };
      });

      const pricingCandidates = uniq(
        [
          original.productId,
          ...preparedParts.map((part) => part.productId),
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
      for (const { part, productId, projectId, lineKind } of preparedParts) {
        await validateExpenseInheritance(tx, {
          lineKind,
          projectId,
          productId,
          purchaseId: chargeId,
          trade: part.trade,
        });
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
      }

      if (attributionPolicy === "inherit" && originalAttributions.length > 0) {
        await tx.insert(expenseAttribution).values(
          inserted.flatMap((createdExpenseId) =>
            originalAttributions.map((attribution) => ({
              expenseId: createdExpenseId,
              role: attribution.role,
              ledgerPartyId: attribution.ledgerPartyId,
              weight: attribution.weight,
            })),
          ),
        );
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
          ...preparedParts.map((part) => part.productId),
        ].filter((value): value is ProductId => value !== null),
        purchaseIds: [chargeId],
      });

      await logAuditEntries(tx, actor, auditEntries);

      const priceAffectedProductIds = await syncChangedEffectivePrices(
        tx,
        pricesBefore,
      );

      return { createdIds: inserted, priceAffectedProductIds };
    },
  );

  const rows = await getDb(db).query.expense.findMany({
    where: and(inArray(expense.id, createdIds), notDeleted(expense)),
    extras: expenseInheritanceReadExtras(),
    ...relations.expense.withProject,
  });
  const [hydratedCreated, createdDataQualities] = await Promise.all([
    hydrateExpenseProjectAllocations(db, rows),
    loadDataQualities(
      db,
      "expense",
      rows.map((row) => row.id),
    ),
  ]);
  return {
    // SAFETY: `row` came from `rows`, which `createdDataQualities` was loaded
    // for.
    items: hydratedCreated.map((row) =>
      dbExpenseToAPI(row, createdDataQualities.get(row.id)!),
    ),
    priceAffectedProductIds,
  };
};

/** Pre-check collisions because a failed unique statement poisons the transaction. */
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

/** Validate source changes within the transaction that changes their defaults. */
const validatePurchaseItemInheritance = async (
  tx: DrizzleTransaction,
  purchaseIds: PurchaseId[],
) => {
  const rows = await tx.query.expense.findMany({
    where: and(inArray(expense.purchaseId, purchaseIds), notDeleted(expense)),
  });
  for (const row of rows) await validateExpenseInheritance(tx, row);
};

/** Moving a purchase source must not silently reattribute principal items. */
const preservePurchaseItemAttribution = async (
  tx: DrizzleTransaction,
  from: PurchaseId[],
  to: PurchaseId | null,
) => {
  const rows = await tx
    .select({
      id: expense.id,
      shortcode: expense.shortcode,
      lineKind: expense.lineKind,
      productId: expense.productId,
      projectId: expense.projectId,
      trade: expense.trade,
      effectiveProjectId: effectiveExpenseProjectSql(),
      effectiveTrade: effectiveExpenseTradeSql(),
    })
    .from(expense)
    .where(and(inArray(expense.purchaseId, from), notDeleted(expense)));
  for (const row of rows) {
    if (row.lineKind !== "principal") {
      if (to === null)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Purchase adjustment ${row.shortcode} cannot be detached. Delete it or move it to another purchase first.`,
        );
      await validateExpenseInheritance(tx, { ...row, purchaseId: to });
      continue;
    }

    if (row.effectiveTrade === null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Principal expense ${row.shortcode} has no effective trade to preserve.`,
      );
    }

    const projectProbe = await validateExpenseInheritance(tx, {
      ...row,
      purchaseId: to,
      trade: row.effectiveTrade,
    });
    let projectId = row.projectId;
    if (projectProbe.effectiveProjectId !== row.effectiveProjectId) {
      if (row.effectiveProjectId === null) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Cannot preserve the unassigned project of ${row.shortcode} under the destination purchase default.`,
        );
      }
      projectId = row.effectiveProjectId;
    }

    let trade = row.trade;
    try {
      const tradeProbe = await validateExpenseInheritance(tx, {
        ...row,
        projectId,
        purchaseId: to,
      });
      if (tradeProbe.effectiveTrade !== row.effectiveTrade) {
        trade = row.effectiveTrade;
      }
    } catch {
      // SILENT: this probe is exploratory — it only decides whether to pin
      // `trade` explicit. The authoritative check runs right below on
      // whatever `trade` ends up being and throws CONSTRAINT_VIOLATION if
      // the final effective values still don't match the original, so a
      // probe failure can't let a real mismatch through silently.
      trade = row.effectiveTrade;
    }

    const next = await validateExpenseInheritance(tx, {
      ...row,
      projectId,
      purchaseId: to,
      trade,
    });
    if (next.effectiveProjectId !== row.effectiveProjectId) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Cannot preserve the unassigned project of ${row.shortcode} under the destination purchase default.`,
      );
    }
    if (next.effectiveTrade !== row.effectiveTrade) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Cannot preserve the effective trade of ${row.shortcode} under the destination purchase defaults.`,
      );
    }
    if (projectId !== row.projectId || trade !== row.trade) {
      await tx
        .update(expense)
        .set({ projectId, trade })
        .where(eq(expense.id, row.id));
    }
  }
};

const carryMissing = <T>(
  current: T | null | undefined,
  incoming: T | null | undefined,
) => (current == null && incoming != null ? incoming : undefined);

const discardedStatedTotalOf = (
  survivor: number | null | undefined,
  dead: number | null | undefined,
) => (survivor != null && dead != null && survivor !== dead ? dead : undefined);

const carryChargeMetadata = async (
  tx: DrizzleTransaction,
  deadId: PurchaseId,
  survivorId: PurchaseId,
) => {
  const selection = {
    statedTotal: purchase.statedTotal,
    displayLabel: purchase.displayLabel,
    notes: purchase.notes,
    date: purchase.date,
  };
  const [dead] = await tx
    .select(selection)
    .from(purchase)
    .where(eq(purchase.id, deadId))
    .limit(1);
  const [survivor] = await tx
    .select(selection)
    .from(purchase)
    .where(eq(purchase.id, survivorId))
    .limit(1);
  const carried = buildPartialUpdateValues({
    statedTotal: carryMissing(survivor?.statedTotal, dead?.statedTotal),
    displayLabel: carryMissing(survivor?.displayLabel, dead?.displayLabel),
    notes: carryMissing(survivor?.notes, dead?.notes),
    date: carryMissing(survivor?.date, dead?.date),
  });
  if (Object.keys(carried).length > 0) {
    await tx.update(purchase).set(carried).where(eq(purchase.id, survivorId));
  }
  return {
    carried,
    discardedStatedTotal: discardedStatedTotalOf(
      survivor?.statedTotal,
      dead?.statedTotal,
    ),
    survivorStatedTotal: survivor?.statedTotal,
  };
};

const moveChargeAllocations = async (
  tx: DrizzleTransaction,
  deadId: PurchaseId,
  survivorId: PurchaseId,
  actor: ActorContext,
) => {
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
  const transactionIds = uniq(
    movingAllocations.map((row) => row.transactionId),
  );
  const before = await readAllocations(tx, transactionIds);
  for (const moving of movingAllocations) {
    const collision = survivorByTransaction.get(moving.transactionId);
    if (collision) {
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
    } else {
      await tx
        .update(financialTransactionAllocation)
        .set({ purchaseId: survivorId, updatedAt: new Date() })
        .where(eq(financialTransactionAllocation.id, moving.id));
    }
  }
  await applyAllocationChanges(tx, { transactionIds, before, actor });
};

const moveChargeImages = async (
  tx: DrizzleTransaction,
  deadId: PurchaseId,
  survivorId: PurchaseId,
) => {
  const rows = await tx.query.entityAttachment.findMany({
    where: and(
      eq(entityAttachment.subjectEntityId, deadId),
      notDeleted(entityAttachment),
    ),
    columns: { imageId: true, sortOrder: true, documentKind: true },
  });
  if (rows.length === 0) return;
  await tx
    .insert(entityAttachment)
    .values(
      rows.map((row) => ({
        subjectEntityId: survivorId,
        role: "attachment" as const,
        imageId: row.imageId,
        sortOrder: row.sortOrder,
        documentKind: row.documentKind ?? "other",
      })),
    )
    .onConflictDoNothing();
  await tx
    .update(entityAttachment)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(entityAttachment.subjectEntityId, deadId),
        notDeleted(entityAttachment),
      ),
    );
};

const moveChargeProducts = async (
  tx: DrizzleTransaction,
  deadId: PurchaseId,
  survivorId: PurchaseId,
) => {
  const rows = await tx.query.purchaseProduct.findMany({
    where: and(
      eq(purchaseProduct.purchaseId, deadId),
      notDeleted(purchaseProduct),
    ),
    columns: { productId: true },
  });
  if (rows.length === 0) return;
  await tx
    .insert(purchaseProduct)
    .values(
      rows.map(({ productId }) => ({ purchaseId: survivorId, productId })),
    )
    .onConflictDoNothing();
  await tx
    .update(purchaseProduct)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(purchaseProduct.purchaseId, deadId), notDeleted(purchaseProduct)),
    );
};

/** Fold charge contents with audited expense re-pointing; callers own index ordering. */
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
  const { carried, discardedStatedTotal, survivorStatedTotal } =
    await carryChargeMetadata(tx, deadId, survivorId);

  await preservePurchaseItemAttribution(tx, [deadId], survivorId);

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
  await moveChargeAllocations(tx, deadId, survivorId, actor);

  // Duplicate document/product links collapse instead of aborting the merge.
  await moveChargeImages(tx, deadId, survivorId);
  await moveChargeProducts(tx, deadId, survivorId);
  await tx
    .update(importSourceClaim)
    .set({ purchaseId: survivorId, updatedAt: new Date() })
    .where(eq(importSourceClaim.purchaseId, deadId));
  await tx
    .update(purchasePaymentEvidence)
    .set({ purchaseId: survivorId, updatedAt: new Date() })
    .where(eq(purchasePaymentEvidence.purchaseId, deadId));

  // Evidence-changing invariant: this fold re-points Expenses,
  // FinancialTransactions, and documents onto the survivor. The next quality
  // read recomputes each affected check's input fingerprint, so its exception
  // becomes stale even though the survivor's own scalar fields may not change.
  // Retain this touch for cache freshness and the existing mutation contract;
  // it is no longer the invalidation mechanism. The linked Products also need
  // the touch because their quality evidence can read through moved Expenses.
  const movedExpenseProducts =
    moved.length > 0
      ? await tx.query.expense.findMany({
          where: inArray(
            expense.id,
            moved.map((id) => parseEntityId("expense", id)),
          ),
          columns: { productId: true },
        })
      : [];
  await touchDataQualityTargets(tx, {
    purchaseIds: [survivorId],
    productIds: movedExpenseProducts
      .map((row) => row.productId)
      .filter((value): value is ProductId => value !== null),
  });

  type PurchaseMergeSurvivorChanges = {
    foldedIn: { from: null; to: PurchaseId };
    carriedOver?: { from: null; to: typeof carried };
    discardedStatedTotal?: {
      from: number;
      to: number | null;
    };
  };
  const survivorChanges: PurchaseMergeSurvivorChanges = {
    foldedIn: { from: null, to: deadId },
  };
  if (Object.keys(carried).length > 0) {
    survivorChanges.carriedOver = { from: null, to: carried };
  }
  if (discardedStatedTotal !== undefined) {
    survivorChanges.discardedStatedTotal = {
      from: discardedStatedTotal,
      to: survivorStatedTotal ?? null,
    };
  }

  await finalizeMerge(tx, {
    entity: "purchase",
    table: purchase,
    keepId: survivorId,
    loserIds: [deadId],
    removal: "soft",
    actor,
    survivorChanges,
  });
};

/** Refuses cross-vendor merges and sets containing multiple non-null order IDs. */

type PurchaseMergeViolation =
  | { kind: "cross-vendor"; offendingIds: PurchaseId[] }
  | { kind: "order-collision"; offendingIds: PurchaseId[]; orderIds: string[] };

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
      orderIds: orderIdBearers.flatMap((row) =>
        row.orderId === null ? [] : [row.orderId],
      ),
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

    const orderIdBearers = rows.filter((r) => r.orderId !== null);

    // Fold while each source Purchase is still live so inherited Expense
    // attribution can be resolved and preserved. Each fold soft-deletes its
    // source, which also vacates the partial unique-index slot before the
    // keeper adopts an order id below.
    for (const loser of losers) {
      await foldChargeInto(tx, loser, keepId, actor);
    }
    mergedCount = losers.length;

    const adopted = orderIdBearers[0];
    if (adopted && adopted.id !== keepId) {
      await tx
        .update(purchase)
        .set({ orderId: adopted.orderId })
        .where(eq(purchase.id, keepId));
    }
    // A run can already target the keeper. Preserve that canonical target and
    // drop the colliding loser row before re-pointing the remaining history;
    // the partial unique index makes a bulk update unsafe here.
    const targetedRuns = await tx
      .select({ id: runTarget.id, runId: runTarget.runId })
      .from(runTarget)
      .where(inArray(runTarget.purchaseId, losers));
    for (const target of targetedRuns) {
      const [existing] = await tx
        .select({ id: runTarget.id })
        .from(runTarget)
        .where(
          and(
            eq(runTarget.runId, target.runId),
            eq(runTarget.purchaseId, keepId),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(runEvidence)
          .set({ targetId: existing.id })
          .where(eq(runEvidence.targetId, target.id));
        await tx.delete(runTarget).where(eq(runTarget.id, target.id));
      } else {
        await tx
          .update(runTarget)
          .set({ purchaseId: keepId, updatedAt: new Date() })
          .where(eq(runTarget.id, target.id));
      }
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
 * Soft-delete charges through the declared policy.
 *
 * Removal-path invariant (root AGENTS.md, guard-enforced): the same
 * transaction soft-deletes the Purchase's attachments and NULLS `purchaseId`
 * on its expenses (audited). Nulling rather than cascading is the point — an
 * expense is the money, and deleting a charge must never delete spend.
 *
 * Returns the detached expenses and every transaction that held a slice, for
 * the caller to refresh after the commit.
 */
export const deletePurchases = (
  db: Database,
  shortcodes: PurchaseShortcode[],
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const ids = await resolveAllOrThrow(tx, "purchase", shortcodes);
    const detaching = await tx
      .select({ id: expense.id })
      .from(expense)
      .where(and(inArray(expense.purchaseId, ids), notDeleted(expense)));
    // Every transaction holding a slice of any purchase being deleted — the
    // mirror alone would miss a split one, whose mirror is NULL.
    const affectedTransactionIds = await transactionIdsAllocatedTo(tx, ids);
    const removed = await deleteByPolicy(tx, {
      entity: "purchase",
      policy: PURCHASE_DELETE_EDGE_POLICY,
      ids,
      actor,
      beforeDelete: (inner) =>
        preservePurchaseItemAttribution(inner, ids, null),
      overrides: {
        // Drop ALL slices of every affected transaction, not just this
        // purchase's: a partial allocation set is not a legal state, whereas
        // zero is ("unlinked evidence"), so a split transaction reverts
        // entirely to unlinked.
        "FinancialTransactionAllocation.purchaseId": async (inner) => {
          if (affectedTransactionIds.length === 0) return;
          const allocationsBefore = await readAllocations(
            inner,
            affectedTransactionIds,
          );
          await inner
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
          await applyAllocationChanges(inner, {
            transactionIds: affectedTransactionIds,
            before: allocationsBefore,
            actor,
          });
        },
      },
    });
    return {
      expenseIds: detaching.map((row) => row.id),
      financialTransactionIds: affectedTransactionIds,
      detachedImageKeys: removed.detachedImageKeys,
      deletedImageShortcodes: removed.deletedImageShortcodes,
      deleted: removed.deleted,
    };
  });
