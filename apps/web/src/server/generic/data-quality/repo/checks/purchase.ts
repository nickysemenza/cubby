import {
  financialTransactionStatus,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import { expenseCreateInput } from "@cubby/schemas/project";
import { RECONCILIATION_TOLERANCE } from "@cubby/schemas/purchase";
import { cents } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { purchase, vendor } from "~/server/db/schema";
import {
  postedRefundPredicate,
  settlementReferencePredicate,
} from "~/server/domains/financial-transaction/repo/financial-reconciliation";
import { settlementConflictSql } from "~/server/domains/financial-transaction/repo/settlement-conflicts";
import {
  purchaseItemizationExpectationSql,
  purchaseHasItemizationSql,
  purchaseHasPrimaryDocumentSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const PURCHASE_QUALITY_RULES_VERSION = 1;
type PurchaseQualityRecord = Awaited<
  ReturnType<typeof loadPurchaseQualityRecords>
>[number];
const vendorRole = expenseCreateInput.shape.economicRole.parse("vendor");
const observed = qualityCheck.observed<PurchaseQualityRecord>;
const when = qualityCheck.when<PurchaseQualityRecord>;

export const purchaseChecks = defineStoredEntityChecks({
  entity: "purchase",
  table: purchase,
  rulesVersion: PURCHASE_QUALITY_RULES_VERSION,
  load: loadPurchaseQualityRecords,
  related: {
    product: (t, productId) => sql`EXISTS (
      SELECT 1 FROM "Expense" dq_pe
      WHERE dq_pe."purchaseId" = ${t.id}
        AND dq_pe."productId" = ${productId}
        AND dq_pe."deletedAt" IS NULL
    )`,
  },
  checks: {
    purchase_vendor_account: when(
      (r) => r.orderEvidence !== "not_expected",
      observed((r) => r.vendorAccountId !== null),
    ),
    purchase_date: observed((r) => r.date !== null),
    order_id: when(
      (r) => r.expectsOrderId,
      observed((r) => r.orderId !== null),
    ),
    stated_total: when(
      (r) => r.hasPrimaryDocument,
      observed((r) => r.statedTotal !== null),
    ),
    empty_expenses: observed((r) => r.expenseCount > 0),
    purchase_spending_category_origin: when(
      (r) => r.spendingCategoryId !== null,
      observed((r) => r.spendingCategoryOrigin !== "legacy"),
    ),
    purchase_itemization_expectation: observed(
      (r) => r.expectation !== "unknown",
    ),
    // A receipt on an empty Purchase still needs extraction, regardless of policy.
    purchase_itemization: when(
      (r) => r.hasPrimaryDocument || r.expectation === "required",
      observed((r) => r.hasItemization),
    ),
    unpriced_expense: observed((r) => r.settleableUnpricedCount === 0),
    paperwork_mismatch: observed((r) => {
      if (r.statedTotal === null || r.vendorCount === 0) return true;
      const delta = cents(r.vendorTotal) - cents(r.statedTotal);
      return (
        Math.abs(delta) <= cents(RECONCILIATION_TOLERANCE) ||
        (r.vendorUnpricedCount === 0 &&
          delta < -cents(RECONCILIATION_TOLERANCE) &&
          cents(r.postedRefundTotal) === delta)
      );
    }),
    settlement_reference: observed((r) => r.hasSettlementReference),
    settlement_mismatch: observed(
      (r) =>
        r.settleableUnpricedCount > 0 ||
        !r.hasSettlement ||
        cents(r.comparisonTotal) === cents(r.settleableTotal),
    ),
    settlement_party_conflict: observed((r) => !r.partyConflict),
    settlement_tender_conflict: observed((r) => !r.tenderConflict),
    purchase_display_image: observed((r) => r.hasDisplayImage),
  },
});

async function loadPurchaseQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  // The page owns both grouped scans. List and queue reads consume only the
  // published checks, never these ledger/settlement inputs.
  const expenses = sql`(SELECT qe."purchaseId",
    count(*)::int AS "expenseCount",
    count(*) FILTER (WHERE qe."cost" IS NULL AND ${sql.raw(actualExpenseSql("qe"))})::int AS "settleableUnpricedCount",
    coalesce(sum(qe."cost") FILTER (WHERE ${sql.raw(actualExpenseSql("qe"))}), 0)::double precision AS "settleableTotal",
    coalesce(sum(qe."cost"::numeric) FILTER (WHERE qe."economicRole" = ${vendorRole}), 0)::double precision AS "vendorTotal",
    count(*) FILTER (WHERE qe."economicRole" = ${vendorRole})::int AS "vendorCount",
    count(*) FILTER (WHERE qe."economicRole" = ${vendorRole} AND qe."cost" IS NULL)::int AS "vendorUnpricedCount"
    FROM "Expense" qe
    WHERE qe."deletedAt" IS NULL AND qe."purchaseId" = ANY(${uuidArrayParam(ids)})
    GROUP BY qe."purchaseId") quality_expenses`;
  const kinds = sql.join(
    purchaseSettlementKinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const aliases = { purchase: "qp", account: "qfa", transaction: "qft" };
  const settles = sql`qft.kind IN (${kinds}) AND qft.status <> ${financialTransactionStatus.enum.void}`;
  const settlements = sql`(SELECT qa."purchaseId",
    coalesce(bool_or(${settles}), false) AS "hasSettlement",
    (CASE WHEN bool_or(qft.kind IN (${kinds}) AND qft.status IN (${financialTransactionStatus.enum.expected}, ${financialTransactionStatus.enum.pending}))
      THEN coalesce(sum(qa.amount) FILTER (WHERE ${settles}), 0)
      ELSE coalesce(sum(qa.amount) FILTER (WHERE qft.kind IN (${kinds}) AND qft.status = ${financialTransactionStatus.enum.posted}), 0)
    END)::double precision AS "comparisonTotal",
    coalesce(sum(qa.amount) FILTER (WHERE ${sql.raw(postedRefundPredicate("qft"))}), 0)::double precision AS "postedRefundTotal",
    coalesce(bool_or(qfa.id IS NOT NULL AND ${sql.raw(settlementReferencePredicate("qft", "qfa"))}), false) AS "hasSettlementReference",
    coalesce(bool_or(${settlementConflictSql("party", aliases)}) FILTER (WHERE ${settles}), false) AS "partyConflict",
    coalesce(bool_or(${settlementConflictSql("tender", aliases)}) FILTER (WHERE ${settles}), false) AS "tenderConflict"
    FROM "FinancialTransactionAllocation" qa
    JOIN "FinancialTransaction" qft ON qft.id = qa."transactionId" AND qft."deletedAt" IS NULL
    JOIN "Purchase" qp ON qp.id = qa."purchaseId" AND qp."deletedAt" IS NULL
    -- includes-deleted: conflict evidence retains the allocated account; reference coverage requires liveness.
    LEFT JOIN "FinancialAccount" qfa ON qfa.id = qft."accountId"
    WHERE qa."deletedAt" IS NULL AND qa."purchaseId" = ANY(${uuidArrayParam(ids)})
    GROUP BY qa."purchaseId") quality_settlements`;
  return unwrapDb(db)
    .select({
      id: purchase.id,
      shortcode: purchase.shortcode,
      vendorAccountId: purchase.vendorAccountId,
      date: purchase.date,
      orderId: purchase.orderId,
      statedTotal: purchase.statedTotal,
      spendingCategoryId: purchase.spendingCategoryId,
      spendingCategoryOrigin: purchase.spendingCategoryOrigin,
      orderEvidence: vendor.orderEvidence,
      expectsOrderId: sql<boolean>`EXISTS (SELECT 1 FROM "ImportSourceOrder" dq_order
      WHERE dq_order."purchaseId" = ${purchase.id} AND dq_order."orderKey" LIKE '%/order/%')`,
      expectation: sql<string>`${purchaseItemizationExpectationSql("Purchase")}`,
      hasPrimaryDocument: sql<boolean>`${purchaseHasPrimaryDocumentSql("Purchase")}`,
      hasItemization: sql<boolean>`${purchaseHasItemizationSql("Purchase")}`,
      expenseCount: sql<number>`coalesce(quality_expenses."expenseCount", 0)`,
      settleableUnpricedCount: sql<number>`coalesce(quality_expenses."settleableUnpricedCount", 0)`,
      settleableTotal: sql<number>`coalesce(quality_expenses."settleableTotal", 0)`,
      vendorTotal: sql<number>`coalesce(quality_expenses."vendorTotal", 0)`,
      vendorCount: sql<number>`coalesce(quality_expenses."vendorCount", 0)`,
      vendorUnpricedCount: sql<number>`coalesce(quality_expenses."vendorUnpricedCount", 0)`,
      hasSettlement: sql<boolean>`coalesce(quality_settlements."hasSettlement", false)`,
      comparisonTotal: sql<number>`coalesce(quality_settlements."comparisonTotal", 0)`,
      postedRefundTotal: sql<number>`coalesce(quality_settlements."postedRefundTotal", 0)`,
      hasSettlementReference: sql<boolean>`coalesce(quality_settlements."hasSettlementReference", false)`,
      partyConflict: sql<boolean>`coalesce(quality_settlements."partyConflict", false)`,
      tenderConflict: sql<boolean>`coalesce(quality_settlements."tenderConflict", false)`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("purchase", sql`${purchase.id}`)}`,
    })
    .from(purchase)
    .leftJoin(vendor, and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)))
    .leftJoin(expenses, sql`quality_expenses."purchaseId" = ${purchase.id}`)
    .leftJoin(
      settlements,
      sql`quality_settlements."purchaseId" = ${purchase.id}`,
    )
    .where(
      and(
        notDeleted(purchase),
        sql`${purchase.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
