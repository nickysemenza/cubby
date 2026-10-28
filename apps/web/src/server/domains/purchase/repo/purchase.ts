import type { EntityRelationPageInput } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  resolveExpenseLineKind,
  type ExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";
import {
  type ExpenseId,
  type ProductId,
  type PurchaseId,
  type PurchaseShortcode,
  parseEntityId,
  parseShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import type {
  LinkExpensesToPurchaseInput,
  MergePurchasesInput,
  MergePurchasesOut,
  PurchaseCreateInput,
  PurchaseUpdateData,
  ReclassifyPurchaseDocumentInput,
  SplitExpenseInput,
} from "@cubby/schemas/purchase";
import {
  purchaseExpenseStatus,
  purchaseFinancialReconciliation,
  purchaseReconciliation,
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
  splitExpenseDelta,
} from "@cubby/schemas/purchase";
import {
  type RawPurchaseOut,
  rawPurchaseOut,
} from "@cubby/schemas/purchase-raw-read";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";
import {
  type RawExpenseOut,
  rawExpenseOut,
} from "@cubby/schemas/work-raw-read";
import { parseShortcode, cents } from "@cubby/shared";
import { and, asc, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { z } from "zod";

import { purchaseLabel } from "~/lib/purchase-label";
import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import type { Database, DrizzleTransaction } from "~/server/db";
import { trimTextSql } from "~/server/db/computed/text-whitespace";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  buildPartialUpdateValues,
  getDb,
  galleryBinding,
  lockAndValidateForDelete,
  notDeleted,
  touchUpdatedAt,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  entityAttachment,
  expense,
  expenseAttribution,
  financialTransactionAllocation,
  image,
  importSourceOrder,
  importSourceProduct,
  ledgerSourceClaim,
  product,
  project,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  emptySpendingCategorySummary,
  loadPurchaseSpendingCategorySummaries,
} from "~/server/domains/expense/repo/expense-category-summary";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
  validateExpenseInheritance,
} from "~/server/domains/expense/repo/expense-inheritance";
import { assertQuantitySignMatchesCost } from "~/server/domains/expense/repo/helpers";
import {
  requireLineRoleClassifier,
  type ExpenseLineRoleClassifier,
} from "~/server/domains/expense/repo/line-role-classifier";
import { expenseScaffold } from "~/server/domains/expense/repo/lookup";
import {
  calculateFinancialReconciliation,
  postedRefundTotal,
  settleableExpenseTotal,
  settleableUnpricedExpenseCount,
  vendorExpenseAggregate,
  vendorExpenseCount,
  vendorExpenseTotal,
  vendorUnpricedExpenseCount,
} from "~/server/domains/financial-transaction/repo/financial-reconciliation";
import {
  applyAllocationChanges,
  readAllocations,
  transactionIdsAllocatedTo,
} from "~/server/domains/financial-transaction/repo/financial-transaction-allocations";
import { syncEntityImages } from "~/server/domains/image/repo/entity-image-sync";
import { resolveMemberAssignee } from "~/server/domains/ledger-party/repo/ledger-party-reference";
import { syncChangedEffectivePrices } from "~/server/domains/product/repo/price-sync";
import { loadEffectiveProductPricesById } from "~/server/domains/product/repo/pricing";
import {
  purchaseCoverageSql,
  purchaseEvidenceFieldResolutionsSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import {
  emptyPurchaseFinancialAggregate,
  loadPurchaseFinancialAggregates,
} from "~/server/domains/purchase/repo/purchase-financial-aggregates";
import {
  purchasePurchaserSetSql,
  purchasePurchaserSql,
} from "~/server/domains/purchase/repo/purchase-purchaser";
import { resolveSplitPartClassification } from "~/server/domains/purchase/repo/purchase-split-draft";
import { purchaseSearch } from "~/server/domains/purchase/repo/search-read-purchase";
import { assertClassificationPolicies } from "~/server/domains/spending-category/repo/classification-field-policy";
import {
  vendorLogoKeySql,
  vendorLogoSummary,
} from "~/server/domains/vendor/repo/vendor-logo";
import {
  type MutationReceipt,
  createEntityReader,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { gapCondition } from "~/server/generic/data-quality/repo/sql";
import {
  loadPurchaseDocumentEvidence,
  loadPurchaseExpenseEvidence,
} from "~/server/generic/field-explanation/repo/field-explanation-evidence";
import {
  validateProductPolicy,
  validateLiveInheritedPolicies,
} from "~/server/generic/inheritance/repo/inheritance-validation";
import { declaredRollup } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  expenseCountLabel,
  reconciliationLabel,
  settlementLabel,
} from "~/server/generic/list/repo/list-display-labels";
import {
  finalizeMerge,
  mergeNotes,
  repointEdge,
  resolveMergeTargets,
} from "~/server/generic/merge/repo/core";
import { cascadeRemoval } from "~/server/generic/removal/repo/core";
/** Purchase repository: one vendor event per row; Expense is the authoritative spend ledger. */
import {
  applyMergePolicy,
  deleteByPolicy,
} from "~/server/generic/removal/repo/dispositions";
import {
  resolveAllOrThrow,
  resolveOrThrow,
  resolveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/generic/shortcode/repo/shortcode-utils";

export const PURCHASE_DELETE_EDGE_POLICY = {
  "Shipment.purchaseId": {
    code: "detach-shipment",
    effect: "detach",
    description:
      "Packages and their tracking evidence survive without a Purchase association.",
  },
  "SourceOrderObservation.purchaseId": {
    code: "preserve-source-observation",
    effect: "preserve",
    description:
      "Immutable extraction history retains its original subject UUID and tombstone without being repointed.",
  },
  "ImportPreparedOrder.targetPurchaseId": {
    code: "preserve-prepared-target",
    effect: "preserve",
    description:
      "An import preparation retains its reviewed target tombstone and must be prepared again before commit.",
  },
  "ImportSourceOrder.purchaseId": {
    code: "detach-import-order",
    effect: "detach",
    description:
      "The order association stays as the Email's accepted history with its Purchase link cleared, and its original-line Product bindings are removed; importing the same order again adds a new association beside it.",
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
  "EntityAttachment.entityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the purchase, and each file is\n      deleted too unless something else still references it.",
  },
  "EntityLink[purchaseProduct].from": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Product links are soft-deleted with the purchase; the Products themselves are not.",
  },
  "EntityLink[purchasePaymentAccount].from": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Payment-account links are soft-deleted with the purchase; the accounts themselves are not.",
  },
  "FinancialTransactionAllocation.purchaseId": {
    code: "soft-delete-allocations-of-affected-transactions",
    effect: "soft-delete",
    description:
      "Deleting a purchase removes its settlement allocations — and, for a transaction that was split across this purchase and others, the sibling slices too, because a partial allocation set is not a legal state: a transaction has either none, or a set summing to its amount. Those transactions revert to unlinked evidence on their accounts; no amount changes. For the ordinary single-allocation transaction this is exactly equivalent to detaching it.",
  },
} as const satisfies IncomingEdgePolicy<"purchase", OperationDisposition>;

export const PURCHASE_MERGE_EDGE_POLICY = {
  "Shipment.purchaseId": {
    code: "repoint-shipment",
    effect: "repoint",
    description:
      "Packages follow the surviving Purchase without changing tracking evidence.",
  },
  "SourceOrderObservation.purchaseId": {
    code: "preserve-source-observation",
    effect: "preserve",
    description:
      "Immutable extraction history retains its original subject UUID and tombstone without being repointed.",
  },
  "ImportPreparedOrder.targetPurchaseId": {
    code: "preserve-prepared-target",
    effect: "preserve",
    description:
      "A merge invalidates preparation against the original target rather than silently changing its approved identity.",
  },
  "ImportSourceOrder.purchaseId": {
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
  "EntityAttachment.entityId": {
    code: "move-dedupe-and-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed purchase's images move onto the survivor, skipping any already filed there, and the source associations are soft-deleted.",
  },
  "EntityLink[purchaseProduct].from": {
    code: "move-dedupe-and-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed purchase's product links move onto the survivor, skipping products already linked there, and the source links are soft-deleted.",
  },
  "EntityLink[purchasePaymentAccount].from": {
    code: "move-dedupe-and-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed purchase's payment-account links move onto the survivor, skipping accounts already linked there, and the source links are soft-deleted.",
  },
  "FinancialTransactionAllocation.purchaseId": {
    code: "move-and-sum-amounts-then-soft-delete-source",
    effect: "move-dedupe",
    description:
      "The absorbed purchase's settlement allocations move onto the survivor. Where BOTH purchases held a slice of the SAME transaction the two slices are SUMMED into one row rather than one being skipped — unlike images and product links an allocation carries an amount, so dropping the duplicate would destroy evidence and break the transaction's sum-to-amount invariant. The source rows are soft-deleted.",
  },
} as const satisfies IncomingEdgePolicy<"purchase", OperationDisposition>;

/** Actual spend is always `SUM(Expense.cost)`, never `statedTotal`. */
const purchaseExpenses = () =>
  related(expense, (e) => sql`${e.purchaseId} = ${outer(purchase.id)}`);
const purchaseId = outer(purchase.id);

// Declared rollups (`purchase.model.derived`); the manifest owns their SQL.
const purchaseExpenseCount = declaredRollup(
  "purchase",
  "expenseCount",
  purchase,
);

const purchaseExpenseTotal = declaredRollup(
  "purchase",
  "expenseTotal",
  purchase,
);

const purchaseUnpricedExpenseCount = purchaseExpenses()
  .where((e) => sql`${e.cost} IS NULL`)
  .count();

// Settlement compares only incurred spend; future rows cannot have settled.
const purchaseSettleableExpenseTotal = settleableExpenseTotal(purchaseId);

const purchaseSettleableUnpricedExpenseCount =
  settleableUnpricedExpenseCount(purchaseId);

const purchaseVendorExpenseTotal = vendorExpenseTotal(purchaseId);
const purchaseVendorExpenseCount = vendorExpenseCount(purchaseId);
const purchaseVendorUnpricedExpenseCount =
  vendorUnpricedExpenseCount(purchaseId);

const purchasePostedRefundTotal = postedRefundTotal(purchaseId);

const purchaseDocumentCount = declaredRollup(
  "purchase",
  "documentCount",
  purchase,
);

const purchaseVendor = (options?: { includeDeleted: true }) =>
  related(vendor, (v) => sql`${v.id} = ${outer(purchase.vendorId)}`, options);

const purchaseVendorName = purchaseVendor().value<string>((v) => v.name);

// Public shortcodes remain resolvable tombstones after a vendor soft-delete.
// Every Purchase names a Vendor row, live or tombstoned, so this is never null.
const purchaseVendorShortcode = sql<string>`${purchaseVendor({
  includeDeleted: true,
}).value((v) => v.shortcode)}`;

const purchaseDefaultProjectShortcode = related(
  project,
  (p) => sql`${p.id} = ${outer(purchase.defaultProjectId)}`,
).value<string>((p) => p.shortcode);

const purchaseVendorAccountShortcode = related(
  vendorAccount,
  (va) => sql`${va.id} = ${outer(purchase.vendorAccountId)}`,
).value<string>((va) => va.shortcode);

const purchaseVendorOrderUrlTemplate = purchaseVendor().value<string>(
  (v) => v.orderUrlTemplate,
);

const purchaseVendorLogoKey = vendorLogoKeySql(outer(purchase.vendorId));

const loadPurchaseImages = async (
  db: Database | DrizzleTransaction,
  id: PurchaseId,
): Promise<RawPurchaseOut["images"]> => {
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
        eq(entityAttachment.entityId, id),
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
    galleryBinding("purchase"),
    id,
    { pendingImageIds, removeImageIds, imageOrder },
  );
  return detachedImageKeys;
};

/**
 * The verdict `reconcilePurchase` gives, in its order. The verdicts are
 * disjoint, so the CASE matches what each verdict's own condition would.
 * Mismatch is the `paperwork_mismatch` gap, not a restated predicate: the
 * `purchasesNotReconciling` Problem must honour a recorded
 * `expected_mismatch` exception, which only the gap condition applies, so an
 * excepted mismatch has no verdict.
 */
const reconciliationSql = (): SQL => {
  const tolerance = cents(RECONCILIATION_TOLERANCE);
  const aggregate = vendorExpenseAggregate(purchaseId);
  const refund = purchasePostedRefundTotal;
  // One vendor-expense scan feeds every verdict; the delta and refund are
  // whole cents, as `reconcilePurchase` compares them. Mirrors its
  // zero-expense guard: once the totals fail to match, a purchase with no
  // lines is `unknown` rather than a mismatch.
  return sql`(SELECT CASE
    WHEN ${gapCondition("purchase", "paperwork_mismatch", purchase)} THEN ${purchaseReconciliation.enum.mismatch}::text
    WHEN verdict.stated IS NULL OR NOT (abs(verdict.delta) <= ${tolerance} OR verdict."expenseCount" > 0) THEN ${purchaseReconciliation.enum.unknown}::text
    WHEN abs(verdict.delta) <= ${tolerance} THEN ${purchaseReconciliation.enum.match}::text
    WHEN verdict."unpricedCount" = 0 AND verdict.delta < ${-tolerance}
      AND verdict.refund = verdict.delta THEN ${purchaseReconciliation.enum.refund_adjusted}::text
  END FROM (
    SELECT ${purchase.statedTotal} AS stated,
      floor((agg.total * 100)::numeric + 0.5) - floor((${purchase.statedTotal} * 100)::numeric + 0.5) AS delta,
      agg."expenseCount", agg."unpricedCount",
      floor((${refund} * 100)::numeric + 0.5) AS refund
    FROM (${aggregate}) agg
  ) verdict)`;
};

// Helper columns typed from `related(...).value` read back as unknown.
const helperText = z.string().nullable();

export const purchaseScaffold = listScaffold("purchase", purchase, {
  derived: {
    reconciliationGap: sql`abs(${purchaseVendorExpenseTotal} - ${purchase.statedTotal})`,
    // A purchase with no live vendor leads a descending list.
    vendorId: { sql: purchaseVendorName, nulls: "high" },
    pricedExpenseTotal: sql`CASE WHEN ${purchaseExpenseCount} > ${purchaseUnpricedExpenseCount} THEN ${purchaseExpenseTotal} END`,
    expenseStatus: sql`CASE
      WHEN ${purchaseExpenseCount} = 0 THEN ${purchaseExpenseStatus.enum.empty}::text
      WHEN ${purchaseUnpricedExpenseCount} > 0 THEN ${purchaseExpenseStatus.enum.unpriced}::text
      ELSE ${purchaseExpenseStatus.enum.priced}::text END`,
    hasDocuments: sql`${purchaseDocumentCount} > 0`,
    financialReconciliation: sql`CASE WHEN ${gapCondition("purchase", "settlement_mismatch", purchase)} THEN ${purchaseFinancialReconciliation.enum.mismatch}::text END`,
    reconciliation: reconciliationSql(),
    effectivePurchaser: {
      value: purchasePurchaserSql,
      set: purchasePurchaserSetSql,
    },
  },
  read: {
    title: sql`(CASE
      WHEN NULLIF(${trimTextSql(purchase.orderId)}, '') IS NOT NULL THEN ${purchase.orderId}
      WHEN ${purchase.date} IS NOT NULL THEN COALESCE((SELECT v."name" FROM "Vendor" v WHERE v."id" = "Purchase"."vendorId"), 'Unknown vendor') || ' · ' || to_char(${purchase.date}::date, 'FMMon FMDD, YYYY')
      ELSE COALESCE((SELECT v."name" FROM "Vendor" v WHERE v."id" = "Purchase"."vendorId"), 'Unknown vendor')
    END) || COALESCE(' (' || NULLIF(${trimTextSql(purchase.displayLabel)}, '') || ')', '')`,
    search: purchaseSearch,
    evidence: {
      expenseCount: loadPurchaseExpenseEvidence,
      documentCount: loadPurchaseDocumentEvidence,
    },
    // Keys outside the read schema are helper columns the bindings read.
    columns: {
      purchaserId: purchasePurchaserSql,
      purchaserOverrideId: sql<
        string | null
      >`(SELECT shortcode FROM "LedgerParty" WHERE id = "Purchase"."purchaserOverrideId")`,
      fieldResolutions: purchaseEvidenceFieldResolutionsSql("Purchase"),
      spendingCategoryName: sql<
        string | null
      >`(SELECT name FROM "SpendingCategory" WHERE id = "Purchase"."spendingCategoryId" AND ${notDeleted("SpendingCategory")})`,
      unpricedExpenseCount: purchaseUnpricedExpenseCount,
      liveVendorName: purchaseVendorName,
      spendingCategoryShortcode: sql<
        string | null
      >`(SELECT shortcode FROM "SpendingCategory" WHERE id = "Purchase"."spendingCategoryId" AND ${notDeleted("SpendingCategory")})`,
      defaultProjectShortcode: purchaseDefaultProjectShortcode,
      vendorShortcode: purchaseVendorShortcode,
      vendorAccountShortcode: purchaseVendorAccountShortcode,
      vendorOrderUrlTemplate: purchaseVendorOrderUrlTemplate,
      vendorLogoKey: purchaseVendorLogoKey,
    },
    media: true,
    references: { purchaserOverrideId: { kind: "public" } },
    bindings: (bind) => {
      const purchaseIds = (ids: readonly string[]) =>
        ids.map((id) => parseEntityId("purchase", id));
      // Expense rollups the coverage and reconciliation verdicts read; loaded
      // only when a projection names one of those keys.
      const aggregates = bind.ids(async ({ db, ids }) => {
        const rows = await unwrapDb(db)
          .select({
            id: purchase.id,
            coverage: purchaseCoverageSql("Purchase"),
            expenseCount: purchaseExpenseCount,
            unpricedExpenseCount: purchaseUnpricedExpenseCount,
            expenseTotal: purchaseExpenseTotal,
            vendorExpenseTotal: purchaseVendorExpenseTotal,
            vendorExpenseCount: purchaseVendorExpenseCount,
            vendorUnpricedExpenseCount: purchaseVendorUnpricedExpenseCount,
            settleableExpenseTotal: purchaseSettleableExpenseTotal,
            settleableUnpricedExpenseCount:
              purchaseSettleableUnpricedExpenseCount,
          })
          .from(purchase)
          .where(inArray(purchase.id, purchaseIds(ids)));
        return new Map(rows.map((row) => [row.id, row]));
      });
      const aggregateOf = (
        loaded: Awaited<ReturnType<typeof aggregates.load>>,
        id: PurchaseId,
      ) => {
        const row = loaded.get(id);
        if (!row) throw new Error(`Purchase aggregates were not loaded: ${id}`);
        return row;
      };
      const financials = bind.ids(async (page) => ({
        aggregates: await aggregates.load(page),
        financial: await loadPurchaseFinancialAggregates(
          page.db,
          purchaseIds(page.ids),
        ),
      }));
      const categories = bind.ids(({ db, ids }) =>
        loadPurchaseSpendingCategorySummaries(db, purchaseIds(ids)),
      );
      const images = bind.ids(async ({ db, ids }) => {
        const byId = await Promise.all(
          purchaseIds(ids).map(
            async (id) => [id, await loadPurchaseImages(db, id)] as const,
          ),
        );
        return new Map(byId);
      });
      return [
        bind(
          rawPurchaseOut.pick({ vendorName: true, displayName: true }),
          (row) => {
            const vendorName = helperText.parse(row.liveVendorName ?? null);
            return {
              vendorName,
              displayName: purchaseLabel({
                orderId: row.orderId,
                displayLabel: row.displayLabel,
                vendorName,
                date: row.date,
              }),
            };
          },
        ),
        bind(rawPurchaseOut.pick({ spendingCategoryId: true }), (row) => ({
          spendingCategoryId: row.spendingCategoryShortcode
            ? parseShortcodeFor(
                "spendingCategory",
                row.spendingCategoryShortcode,
              )
            : null,
        })),
        bind(
          rawPurchaseOut.pick({
            vendorId: true,
            vendorAccountId: true,
            defaultProjectId: true,
            orderUrl: true,
          }),
          (row) => {
            if (!row.vendorShortcode)
              throw new Error("Purchase vendor was not loaded");
            return {
              vendorId: parseShortcodeFor("vendor", row.vendorShortcode),
              vendorAccountId: row.vendorAccountShortcode
                ? parseShortcodeFor("vendorAccount", row.vendorAccountShortcode)
                : null,
              defaultProjectId: row.defaultProjectShortcode
                ? parseShortcodeFor("project", row.defaultProjectShortcode)
                : null,
              orderUrl: purchaseOrderUrl({
                orderUrlTemplate: helperText.parse(
                  row.vendorOrderUrlTemplate ?? null,
                ),
                orderId: row.orderId,
              }),
            };
          },
        ),
        bind(rawPurchaseOut.pick({ vendorLogo: true }), (row) => ({
          vendorLogo: vendorLogoSummary(row),
        })),
        // A page shows the display image; only the record read lists files.
        bind(rawPurchaseOut.pick({ images: true }), () => ({ images: [] })),
        images.fields(
          rawPurchaseOut.pick({ images: true }),
          (row, loaded) => ({ images: loaded.get(row.id) ?? [] }),
          { scope: "detail" },
        ),
        aggregates.fields(
          rawPurchaseOut.pick({
            coverage: true,
            bookingCoverage: true,
            documentCoverage: true,
            itemizationCoverage: true,
            productsCoverage: true,
            expenseCountLabel: true,
          }),
          (row, loaded) => {
            const value = aggregateOf(loaded, row.id);
            return {
              coverage: value.coverage,
              bookingCoverage: value.coverage.booking,
              documentCoverage: value.coverage.document,
              itemizationCoverage: value.coverage.itemization,
              productsCoverage: value.coverage.products,
              expenseCountLabel: expenseCountLabel(
                Number(value.expenseCount),
                Number(value.unpricedExpenseCount),
              ),
            };
          },
        ),
        categories.fields(
          rawPurchaseOut.pick({ spendingCategorySummary: true }),
          (row, loaded) => ({
            spendingCategorySummary:
              loaded.get(row.id) ?? emptySpendingCategorySummary(),
          }),
        ),
        financials.fields(
          rawPurchaseOut.pick({
            reconciliation: true,
            financialReconciliation: true,
            reconciliationLabel: true,
            financialReconciliationLabel: true,
          }),
          (row, loaded) => {
            const value = aggregateOf(loaded.aggregates, row.id);
            const financial =
              loaded.financial.get(row.id) ?? emptyPurchaseFinancialAggregate();
            const reconciliation = reconcilePurchase({
              statedTotal: row.statedTotal,
              expenseTotal: Number(value.vendorExpenseTotal),
              expenseCount: Number(value.vendorExpenseCount),
              unpricedExpenseCount: Number(value.vendorUnpricedExpenseCount),
              postedRefundTotal: financial.postedRefundTotal,
            });
            const financialReconciliation = calculateFinancialReconciliation({
              settleableExpenseTotal: Number(value.settleableExpenseTotal),
              settleableUnpricedExpenseCount: Number(
                value.settleableUnpricedExpenseCount,
              ),
              ...financial,
            });
            return {
              reconciliation,
              financialReconciliation,
              reconciliationLabel: reconciliationLabel({
                statedTotal: row.statedTotal,
                expenseTotal: Number(value.expenseTotal),
                reconciliation,
              }),
              financialReconciliationLabel: settlementLabel(
                financialReconciliation,
              ),
            };
          },
        ),
      ];
    },
  },
});

const purchaseReader = createEntityReader({
  entity: "purchase",
  scaffold: purchaseScaffold,
  output: rawPurchaseOut,
});
/** One live Purchase by internal id; throws `PURCHASE_NOT_FOUND` when absent. */
export const readPurchaseById = purchaseReader.getByID;
/** One live Purchase by public code, or null. */
export const readPurchase = purchaseReader.getByShortcode;

/** Narrow root-table projection for relation paging; the scaffold owns the count. */
export function pagePurchaseRelationTargets(
  db: Database,
  where: SQL | undefined,
  orderBy: SQL[],
  input: Pick<EntityRelationPageInput, "offset" | "limit">,
) {
  return purchaseScaffold.raw(
    db,
    {
      filters: {},
      sorts: [],
      pagination: { pageIndex: 0, pageSize: input.limit },
      projection: [],
    },
    {
      where,
      orderBy,
      select: (page) =>
        getDb(db)
          .select({ id: purchase.id, code: purchase.shortcode })
          .from(purchase)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(input.offset),
    },
  );
}

export const reclassifyPurchaseDocument = async (
  db: Database,
  input: ReclassifyPurchaseDocumentInput,
  actor: ActorContext,
): Promise<RawPurchaseOut> => {
  const id = await resolveOrThrow(db, "purchase", input.purchaseId);
  const imageId = await resolveOrThrow(db, "image", input.imageId);
  await withTransaction(db, async (tx) => {
    const before = await tx.query.entityAttachment.findFirst({
      where: and(
        eq(entityAttachment.entityId, id),
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
    await touchUpdatedAt(tx, purchase, [id]);
    await logAuditEntry(tx, actor, {
      entityKind: "purchase",
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
  return readPurchaseById(db, id);
};

/** Order IDs are vendor-scoped; never group same-number orders across vendors. */
export const getPurchaseExpenses = async (
  db: Database,
  id: PurchaseId,
): Promise<RawExpenseOut[]> => {
  const rows = await getDb(db)
    .select({ id: expense.id })
    .from(expense)
    .where(and(eq(expense.purchaseId, id), notDeleted(expense)))
    .orderBy(asc(expense.date), asc(expense.name));
  const read = await expenseScaffold.getByIds(
    db,
    rows.map((row) => row.id),
  );
  return read.data.map((row) => rawExpenseOut.parse(row));
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

export const createPurchase = defineMutationWriter({
  entity: "purchase",
  read: async (
    receipt: MutationReceipt<"purchase">,
    db: Database,
    _data: PurchaseCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await readPurchaseById(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: PurchaseCreateInput,
    actor: ActorContext,
  ) => {
    const id = await withTransaction(db, async (tx) => {
      const vendorId = await resolveOrThrow(tx, "vendor", data.vendorId);
      const vendorAccountId = data.vendorAccountId
        ? await resolveOrThrow(tx, "vendorAccount", data.vendorAccountId)
        : null;
      const created = await insertWithShortcode(tx, "purchase", {
        defaultProjectId: data.defaultProjectId
          ? await resolveOrThrow(tx, "project", data.defaultProjectId)
          : null,
        spendingCategoryId: data.spendingCategoryId
          ? await resolveOrThrow(
              tx,
              "spendingCategory",
              data.spendingCategoryId,
            )
          : null,
        spendingCategoryOrigin: data.spendingCategoryId ? "manual" : "legacy",
        itemizationExpectation: data.itemizationExpectation,
        defaultTrade: data.defaultTrade,
        vendorId,
        vendorAccountId,
        purchaserOverrideId: await resolveMemberAssignee(
          tx,
          data.purchaserOverrideId,
        ),
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
        entityKind: "purchase",
        entityId: created.id,
        action: "create",
      });
      return created.id;
    });
    return readOutput({ entityId: id });
  },
});

const resolvePurchaseDefaultProjectUpdate = async (
  tx: DrizzleTransaction,
  shortcode: string | null | undefined,
) => (shortcode == null ? shortcode : resolveOrThrow(tx, "project", shortcode));

const resolvePurchaseCategoryUpdate = async (
  tx: DrizzleTransaction,
  shortcode: string | null | undefined,
) =>
  shortcode == null
    ? shortcode
    : resolveOrThrow(tx, "spendingCategory", shortcode);

const reviewedPurchaseCategoryOrigin = (
  value: PurchaseUpdateData["spendingCategoryId"],
  sourceOrigin?: "source",
): "manual" | "source" | undefined =>
  value === undefined ? undefined : (sourceOrigin ?? "manual");

export const updatePurchase = defineMutationWriter({
  entity: "purchase",
  read: async (
    receipt: MutationReceipt<"purchase">,
    db: Database,
    _shortcode: PurchaseShortcode,
    _data: PurchaseUpdateData,
    _actor: ActorContext,
    _options: { spendingCategoryOrigin?: "source" } = {},
  ) => ({
    output: await readPurchaseById(db, receipt.entityId),
    entityId: receipt.entityId,
    detachedImageKeys: receipt.detachedImageKeys ?? [],
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: PurchaseShortcode,
    data: PurchaseUpdateData,
    actor: ActorContext,
    options: { spendingCategoryOrigin?: "source" } = {},
  ) => {
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
          purchaserOverrideId: await resolveMemberAssignee(
            tx,
            data.purchaserOverrideId,
          ),
          defaultProjectId: await resolvePurchaseDefaultProjectUpdate(
            tx,
            data.defaultProjectId,
          ),
          spendingCategoryId: await resolvePurchaseCategoryUpdate(
            tx,
            data.spendingCategoryId,
          ),
          spendingCategoryOrigin: reviewedPurchaseCategoryOrigin(
            data.spendingCategoryId,
            options.spendingCategoryOrigin,
          ),
          itemizationExpectation: data.itemizationExpectation,
          defaultTrade: data.defaultTrade,
          orderId:
            data.orderId === undefined
              ? undefined
              : data.orderId?.trim() || null,
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

      if (
        [
          "vendorId",
          "defaultProjectId",
          "spendingCategoryId",
          "defaultTrade",
        ].some((key) => key in data)
      ) {
        await validatePurchaseItemInheritance(tx, [id]);
        await validateLiveInheritedPolicies(tx, {
          kind: "purchase",
          ids: [id],
        });
      }

      const changes = computeChanges(before, after, [
        ...entityFieldModels.purchase.audit,
      ]);
      if (changes) {
        await logAuditEntry(tx, actor, {
          entityKind: "purchase",
          entityId: id,
          action: "update",
          changes,
        });
      }
    });

    return readOutput({ entityId: id, detachedImageKeys });
  },
});

export const linkExpensesToPurchase = async (
  db: Database,
  input: LinkExpensesToPurchaseInput,
  actor: ActorContext,
): Promise<RawPurchaseOut> => {
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
    await validateProductPolicy(tx, {
      expenseIds: before.map((row) => row.id),
    });

    await touchUpdatedAt(
      tx,
      product,
      before.flatMap((row) => (row.productId ? [row.productId] : [])),
    );
    await touchUpdatedAt(tx, purchase, [
      purchaseId,
      ...before.flatMap((row) => (row.purchaseId ? [row.purchaseId] : [])),
    ]);

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
                entityKind: "expense" as const,
                entityId: row.id,
                action: "update" as const,
                changes,
              },
            ]
          : [];
      }),
    );
  });

  return readPurchaseById(db, purchaseId);
};

/** A split replaces one ledger amount with parts that conserve its exact cents. */
export const splitExpense = async (
  db: Database,
  input: SplitExpenseInput,
  actor: ActorContext,
  classifyLineRole?: ExpenseLineRoleClassifier,
): Promise<{
  items: RawExpenseOut[];
  priceAffectedProductIds: ProductId[];
}> => {
  const { attributionPolicy, parts: requestedParts } = input;
  const expenseId = await resolveOrThrow(db, "expense", input.expenseId);
  const [originalPreflight] = await getDb(db)
    .select({ purchaseId: expense.purchaseId })
    .from(expense)
    .where(and(eq(expense.id, expenseId), notDeleted(expense)))
    .limit(1);
  if (!originalPreflight)
    throw createAppError(
      "EXPENSE_NOT_FOUND",
      `Expense not found: ${expenseId}`,
    );
  if (!originalPreflight.purchaseId)
    throw createAppError(
      "PURCHASE_NOT_FOUND",
      `Cannot split an expense with no purchase attached (${expenseId}) — record its vendor first.`,
    );
  const preflightProductIds = await Promise.all(
    requestedParts.map((part) =>
      part.productId ? resolveOrThrow(db, "product", part.productId) : null,
    ),
  );
  const parts: Array<
    Omit<(typeof requestedParts)[number], "lineKind"> & {
      lineKind: ExpenseLineKind;
    }
  > = [];
  for (const [index, part] of requestedParts.entries()) {
    const productId = preflightProductIds[index] ?? null;
    const lineKind =
      part.lineKind !== undefined || productId !== null
        ? resolveExpenseLineKind({ lineKind: part.lineKind, productId })
        : await requireLineRoleClassifier(classifyLineRole)(db, actor, {
            name: part.name,
            cost: part.cost,
            notes: part.notes ?? null,
          });
    parts.push({ ...part, lineKind });
  }

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

      // The cents comparison the split form's check (`checkSplitDraft`) makes, from the one
      // shared computation, so a split the form accepts is never refused here.
      if (
        original.cost !== null &&
        splitExpenseDelta(
          original.cost,
          parts.map((part) => part.cost),
        ).delta !== 0
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
      if (
        partProductIds.some(
          (productId, index) =>
            productId !== (preflightProductIds[index] ?? null),
        )
      ) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "A split Product changed while receipt roles were being resolved.",
        );
      }
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
      const classifications = parts.map((part) => {
        return resolveSplitPartClassification({
          originalSpendingCategoryId: original.spendingCategoryId,
          lineKind: part.lineKind,
          partSpendingCategoryId: part.spendingCategoryId,
        });
      });
      const spendingCategoryIds = await Promise.all(
        classifications.map((classification, index) => {
          const partCategoryId = parts[index]?.spendingCategoryId;
          if (partCategoryId === undefined)
            return classification.inheritsOriginal
              ? original.spendingCategoryId
              : null;
          return classification.spendingCategoryId === null
            ? null
            : resolveOrThrow(
                tx,
                "spendingCategory",
                classification.spendingCategoryId,
              );
        }),
      );
      const preparedParts = parts.map((part, index) => {
        const productId = partProductIds[index] ?? null;
        const projectId = projectIds[index];
        if (projectId === undefined) {
          throw new Error(
            `Default project resolution lost part ${String(index + 1)}`,
          );
        }
        const classification = classifications[index];
        if (!classification)
          throw new Error("Missing classification for split part");
        const lineKind = classification.lineKind;
        assertClassificationPolicies("expense", {
          lineKind,
          lineBasis: original.lineBasis,
          productId,
          spendingCategoryId: spendingCategoryIds[index] ?? null,
          projectId,
        });
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
          spendingCategoryId: spendingCategoryIds[index] ?? null,
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

      const inserted: ExpenseId[] = [];
      for (const {
        part,
        productId,
        projectId,
        lineKind,
        spendingCategoryId,
      } of preparedParts) {
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
          economicRole: original.economicRole,
          spendingCategoryId,
          bookingTransactionCode: original.bookingTransactionCode,
          lineBasis: original.lineBasis,
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
      await validateProductPolicy(tx, { expenseIds: inserted });

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
        entityKind: "expense" as const,
        entityId: id,
        action: "create" as const,
      }));
      await cascadeRemoval(tx, {
        entity: "expense",
        ids: [expenseId],
        audit: { into: auditEntries },
      });

      await touchUpdatedAt(
        tx,
        product,
        [
          original.productId,
          ...preparedParts.map((part) => part.productId),
        ].filter((value) => value !== null),
      );
      await touchUpdatedAt(tx, purchase, [chargeId]);

      await logAuditEntries(tx, actor, auditEntries);

      const priceAffectedProductIds = await syncChangedEffectivePrices(
        tx,
        pricesBefore,
      );

      return { createdIds: inserted, priceAffectedProductIds };
    },
  );

  const created = await expenseScaffold.getByIds(db, createdIds);
  return {
    items: created.data.map((row) => rawExpenseOut.parse(row)),
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
      entityKind: "purchase",
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
    if (row.lineKind === "unclassified") {
      await validateExpenseInheritance(tx, { ...row, purchaseId: to });
      continue;
    }
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
  options: { notes?: string | null },
) => {
  const selection = {
    purchaserOverrideId: purchase.purchaserOverrideId,
    spendingCategoryId: purchase.spendingCategoryId,
    spendingCategoryOrigin: purchase.spendingCategoryOrigin,
    itemizationExpectation: purchase.itemizationExpectation,

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
  if (!dead || !survivor)
    throw new Error("Both Purchases must exist before merging their metadata.");
  if (
    survivor.itemizationExpectation != null &&
    dead.itemizationExpectation != null &&
    survivor.itemizationExpectation !== dead.itemizationExpectation
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "These Purchases have conflicting itemization expectations. Review their expectations before merging.",
    );
  if (
    survivor.spendingCategoryId != null &&
    dead.spendingCategoryId != null &&
    survivor.spendingCategoryId !== dead.spendingCategoryId
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "These Purchases have conflicting spending categories. Preserve item overrides and review their defaults before merging.",
    );
  if (
    survivor.purchaserOverrideId !== null &&
    dead.purchaserOverrideId !== null &&
    survivor.purchaserOverrideId !== dead.purchaserOverrideId
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "These Purchases have conflicting purchaser overrides. Reconcile them before merging.",
    );
  const notes =
    options.notes === undefined
      ? mergeNotes(survivor.notes, dead.notes)
      : options.notes;
  const carried = buildPartialUpdateValues({
    purchaserOverrideId: carryMissing(
      survivor.purchaserOverrideId,
      dead.purchaserOverrideId,
    ),
    spendingCategoryId: carryMissing(
      survivor.spendingCategoryId,
      dead.spendingCategoryId,
    ),
    spendingCategoryOrigin:
      survivor.spendingCategoryId == null && dead.spendingCategoryId != null
        ? dead.spendingCategoryOrigin
        : undefined,
    itemizationExpectation: carryMissing(
      survivor.itemizationExpectation,
      dead.itemizationExpectation,
    ),

    statedTotal: carryMissing(survivor.statedTotal, dead.statedTotal),
    displayLabel: carryMissing(survivor.displayLabel, dead.displayLabel),
    notes: notes !== survivor.notes ? notes : undefined,
    date: carryMissing(survivor.date, dead.date),
  });
  if (Object.keys(carried).length > 0) {
    await tx.update(purchase).set(carried).where(eq(purchase.id, survivorId));
  }
  return {
    carried,
    discardedStatedTotal: discardedStatedTotalOf(
      survivor.statedTotal,
      dead.statedTotal,
    ),
    survivorStatedTotal: survivor.statedTotal,
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
      eq(entityAttachment.entityId, deadId),
      notDeleted(entityAttachment),
    ),
    columns: { imageId: true, sortOrder: true, documentKind: true },
  });
  if (rows.length === 0) return;
  await tx
    .insert(entityAttachment)
    .values(
      rows.map((row) => ({
        entityId: survivorId,
        entityKind: "purchase" as const,
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
      and(eq(entityAttachment.entityId, deadId), notDeleted(entityAttachment)),
    );
};

/**
 * Fold charge contents with audited expense re-pointing; callers own index
 * ordering and validate the Product policy once the whole write lands (a
 * Vendor merge folds before repointing to the keeper, whose context decides).
 */
export const foldChargeInto = async (
  tx: DrizzleTransaction,
  deadId: PurchaseId,
  survivorId: PurchaseId,
  actor: ActorContext,
  options: { notes?: string | null } = {},
): Promise<void> => {
  // Implicit folds from Expense corrections must read notes after concurrent edits commit.
  await lockAndValidateForDelete(
    tx,
    purchase,
    [deadId, survivorId],
    "Purchase",
  );
  // Purchase-level vendor truth has to come along, not just the lines and documents.
  // `statedTotal` especially: it is the reconciliation cue the whole `Purchase`
  // table exists to hold, and dropping it here meant a vendor typo-fix on a
  // single-line charge silently destroyed it (the fold is reached from
  // `resolveCharge`, not only from an explicit merge).
  //
  // Notes preserve both original texts; other metadata fills gaps. When both
  // carry a `statedTotal` and they disagree, the survivor's stands and the
  // discarded one is named in the audit row rather than vanishing: two different
  // stated totals is a real conflict and picking silently would be the worse
  // failure.
  const { carried, discardedStatedTotal, survivorStatedTotal } =
    await carryChargeMetadata(tx, deadId, survivorId, options);

  await preservePurchaseItemAttribution(tx, [deadId], survivorId);

  // Settlement allocations move onto the survivor, and where BOTH purchases held
  // a slice of the SAME transaction the two slices are SUMMED into one row.
  //
  // ⚠️ `onConflictDoNothing` — what the images below correctly use — is exactly
  // wrong for allocations and must never be copied onto that edge. An
  // allocation carries an amount, so skipping the duplicate would destroy that
  // money-shaped evidence and leave the transaction's allocations no longer
  // summing to its amount. The mirror column is re-derived from the surviving
  // allocations rather than repointed: a transaction holding a slice of both
  // purchases collapses to a single slice and becomes singly linked again.
  //
  // Everything else follows the declared `PURCHASE_MERGE_EDGE_POLICY`; these
  // overrides are the edges whose move is not a plain column write.
  let moved: string[] = [];
  await applyMergePolicy(tx, {
    entity: "purchase",
    policy: PURCHASE_MERGE_EDGE_POLICY,
    keepId: survivorId,
    loserIds: [deadId],
    liveOnly: true,
    overrides: {
      "Expense.purchaseId": async () => {
        moved = await repointEdge(tx, "purchase", "Expense.purchaseId", {
          from: [deadId],
          to: survivorId,
          liveOnly: true,
        });
        await logAuditEntries(
          tx,
          actor,
          moved.map((id) => ({
            entityKind: "expense" as const,
            entityId: id,
            action: "update" as const,
            changes: { purchaseId: { from: deadId, to: survivorId } },
          })),
        );
      },
      "FinancialTransactionAllocation.purchaseId": () =>
        moveChargeAllocations(tx, deadId, survivorId, actor),
      // Duplicate document links collapse instead of aborting the merge.
      "EntityAttachment.entityId": () =>
        moveChargeImages(tx, deadId, survivorId),
    },
  });

  // Moved Expenses and documents change current quality inputs. The source
  // registration below enrolls the broad family; retained waivers stay durable.
  // Touch affected records for cache freshness, not quality invalidation.
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
  await touchUpdatedAt(tx, purchase, [survivorId]);
  await touchUpdatedAt(
    tx,
    product,
    movedExpenseProducts.flatMap((row) =>
      row.productId ? [row.productId] : [],
    ),
  );

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
): Promise<
  Omit<MergePurchasesOut, "purchase"> & { purchase: RawPurchaseOut }
> => {
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
      columns: { id: true, vendorId: true, orderId: true, notes: true },
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
    // Plan from original rows so repeated donor notes cannot be appended twice by sequential folds.
    const notes = mergeNotes(
      keeper.notes,
      ...losers.map((id) => rows.find((row) => row.id === id)?.notes),
    );

    // Fold while each source Purchase is still live so inherited Expense
    // attribution can be resolved and preserved. Each fold soft-deletes its
    // source, which also vacates the partial unique-index slot before the
    // keeper adopts an order id below.
    for (const loser of losers) {
      await foldChargeInto(tx, loser, keepId, actor, { notes });
    }
    // Carried metadata (a category) can reclassify the keeper's own lines.
    await validateProductPolicy(tx, { purchaseId: keepId });
    mergedCount = losers.length;

    const adopted = orderIdBearers[0];
    if (adopted && adopted.id !== keepId) {
      await tx
        .update(purchase)
        .set({ orderId: adopted.orderId })
        .where(eq(purchase.id, keepId));
    }
    await logAuditEntries(tx, actor, [
      {
        entityKind: "purchase" as const,
        entityId: keepId,
        action: "update" as const,
        changes: { mergedFrom: { from: null, to: losers } },
      },
    ]);
  });

  return {
    purchase: await readPurchaseById(db, keepId),
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
        "ImportSourceOrder.purchaseId": async (inner) => {
          const orders = inner
            .select({ id: importSourceOrder.id })
            .from(importSourceOrder)
            .where(inArray(importSourceOrder.purchaseId, ids));
          // Bindings name the deleted Purchase's lines and would otherwise
          // keep their Products from being deleted.
          await inner
            .delete(importSourceProduct)
            .where(inArray(importSourceProduct.sourceOrderId, orders));
          await inner
            .update(importSourceOrder)
            .set({ purchaseId: null, updatedAt: new Date() })
            .where(inArray(importSourceOrder.purchaseId, ids));
        },
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
