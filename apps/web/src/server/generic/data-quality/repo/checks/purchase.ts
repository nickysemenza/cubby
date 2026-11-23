import { emailPurchaseLinkState } from "@cubby/schemas/email-fields";
import {
  financialTransactionKind,
  financialTransactionStatus,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import { mailEvent } from "@cubby/schemas/mailbox-research";
import { expenseCreateInput } from "@cubby/schemas/project";
import { RECONCILIATION_TOLERANCE } from "@cubby/schemas/purchase";
import { cents } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { purchase, vendor } from "~/server/db/schema";
import { emailLinkDecisionsForPurchasesSql } from "~/server/domains/email/repo/email-decision-sql";
import {
  postedRefundPredicate,
  settlementReferencePredicate,
} from "~/server/domains/financial-transaction/repo/financial-reconciliation";
import {
  purchaseMailMembersSql,
  purchaseMembersSql,
  purchasePayingAccountIdsSql,
  settlementPartyConflictSql,
} from "~/server/domains/financial-transaction/repo/settlement-conflicts";
import { acceptedOrdersBoundToSql } from "~/server/domains/purchase-import/repo/accepted-order-read";
import {
  purchaseItemizationExpectationSql,
  purchaseHasItemizationSql,
  purchaseHasPrimaryDocumentSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const PURCHASE_QUALITY_RULES_VERSION = 4;
type PurchaseQualityRecord = Awaited<
  ReturnType<typeof loadPurchaseQualityRecords>
>[number];
const vendorRole = expenseCreateInput.shape.economicRole.parse("vendor");
const observed = qualityCheck.observed<PurchaseQualityRecord>;
const when = qualityCheck.when<PurchaseQualityRecord>;
/** Ledger checks wait while a notice's empty Purchase waits for its order details. */
const withOrderDetails = (check: ReturnType<typeof observed>) =>
  when((r) => !r.awaitingOrderDetails, check);

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
        AND ${notDeleted("dq_pe")}
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
      (r) => r.hasPrimaryDocument && !r.awaitingOrderDetails,
      observed((r) => r.statedTotal !== null),
    ),
    empty_expenses: withOrderDetails(observed((r) => r.expenseCount > 0)),
    purchase_spending_category_origin: when(
      (r) => r.spendingCategoryId !== null,
      observed((r) => r.spendingCategoryOrigin !== "legacy"),
    ),
    purchase_itemization_expectation: observed(
      (r) => r.expectation !== "unknown",
    ),
    // A receipt on an empty Purchase still needs extraction, regardless of policy.
    purchase_itemization: when(
      (r) =>
        (r.hasPrimaryDocument || r.expectation === "required") &&
        !r.awaitingOrderDetails,
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
    settlement_reference: withOrderDetails(
      observed((r) => r.hasSettlementReference),
    ),
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
  // The page owns both grouped scans. List and queue reads consume the
  // published checks.
  const client = unwrapDb(db);
  const requested = client.$with("quality_requested", {}).as(sql`
    SELECT "Purchase".id FROM "Purchase"
    WHERE ${notDeleted(purchase)} AND "Purchase".id = ANY(${uuidArrayParam(ids)})
  `);
  const expenses = client.$with("quality_expenses", {}).as(sql`
    SELECT qe."purchaseId",
    count(*)::int AS "expenseCount",
    count(*) FILTER (WHERE qe."costMinor" IS NULL AND ${sql.raw(actualExpenseSql("qe"))})::int AS "settleableUnpricedCount",
    (coalesce(sum(qe."costMinor") FILTER (WHERE ${sql.raw(actualExpenseSql("qe"))}), 0) / 100.0)::double precision AS "settleableTotal",
    (coalesce(sum(qe."costMinor") FILTER (WHERE qe."economicRole" = ${vendorRole}), 0) / 100.0)::double precision AS "vendorTotal",
    count(*) FILTER (WHERE qe."economicRole" = ${vendorRole})::int AS "vendorCount",
    count(*) FILTER (WHERE qe."economicRole" = ${vendorRole} AND qe."costMinor" IS NULL)::int AS "vendorUnpricedCount"
    FROM "Expense" qe
    WHERE ${notDeleted("qe")} AND qe."purchaseId" IN (SELECT id FROM ${requested})
    GROUP BY qe."purchaseId"
  `);
  const accepted = client.$with("quality_accepted_orders", {}).as(sql`
    SELECT orders."boundPurchaseId" AS "purchaseId",
      bool_or(orders."orderKey" LIKE '%/order/%') AS "expectsOrderId"
    FROM ${acceptedOrdersBoundToSql((id) => sql`${id} IN (SELECT id FROM ${requested})`)} orders
    GROUP BY orders."boundPurchaseId"
  `);
  // The notice rule applies only to empty Purchases without accepted sources.
  // Resolve the current lifecycle links for that page subset together.
  const notices = client.$with("quality_waiting_for_details", {}).as(sql`
    WITH waiting AS MATERIALIZED (
      SELECT requested.id FROM ${requested} requested
      LEFT JOIN ${expenses} expenses ON expenses."purchaseId" = requested.id
      LEFT JOIN ${accepted} accepted ON accepted."purchaseId" = requested.id
      WHERE expenses."purchaseId" IS NULL AND accepted."purchaseId" IS NULL
    )
    SELECT DISTINCT link."purchaseId"
    FROM ${emailLinkDecisionsForPurchasesSql(sql`SELECT id FROM waiting`)} link
    JOIN "OrderMailEvent" event ON event.id = link."eventId"
    WHERE link.active AND link.decision = ${emailPurchaseLinkState.enum.linked}
      AND event.event IN (${mailEvent.enum.shipped}, ${mailEvent.enum.delivered})
  `);
  const kinds = sql.join(
    purchaseSettlementKinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const settlingKinds = sql`qft.kind IN (${kinds})`;
  const settlementRows = client.$with("quality_settlement_rows", {}).as(sql`
    SELECT qa."purchaseId", qa."amountMinor", qft.id, qft."accountId",
      qft.kind, qft.status, qft."transactionDate", qft."postedDate",
      ${settlingKinds} AS "settlingKind",
      (${settlingKinds} AND qft.status <> ${financialTransactionStatus.enum.void}) AS settles,
      (qft.kind <> ${financialTransactionKind.enum.refund}) AS charge
    FROM "FinancialTransactionAllocation" qa
    JOIN "FinancialTransaction" qft ON qft.id = qa."transactionId" AND ${notDeleted("qft")}
    WHERE ${notDeleted("qa")} AND qa."purchaseId" IN (SELECT id FROM ${requested})
  `);
  const settlingPurchases = client.$with("quality_settling_purchases", {})
    .as(sql`
    SELECT qp.id, qp."deletedAt", qp."vendorAccountId", qp."purchaserOverrideId", qp."vendorId", qp.date,
      demand.charge
    FROM "Purchase" qp
    JOIN (
      SELECT "purchaseId", bool_or(charge) AS charge
      FROM ${settlementRows} WHERE settles GROUP BY "purchaseId"
    ) demand ON demand."purchaseId" = qp.id
    WHERE ${notDeleted("qp")}
  `);
  const missingMemberPurchases = sql`
    SELECT qp.id, qp."deletedAt"
    FROM ${settlingPurchases} qp
    LEFT JOIN "VendorAccount" va ON va.id = qp."vendorAccountId" AND ${notDeleted("va")}
    WHERE qp."purchaserOverrideId" IS NULL AND va."ledgerPartyId" IS NULL
  `;
  const members = client
    .$with("quality_purchase_members", {})
    .as(
      purchaseMembersSql(
        sql`SELECT * FROM ${settlingPurchases}`,
        purchaseMailMembersSql(missingMemberPurchases),
      ),
    );
  const tenders = client.$with("quality_purchase_tenders", {}).as(sql`
    SELECT qp.id, ${purchasePayingAccountIdsSql("qp")} AS accounts
    FROM ${settlingPurchases} qp WHERE qp.charge
    OFFSET 0
  `);
  const settlements = sql`(SELECT qft."purchaseId",
    coalesce(bool_or(qft.settles), false) AS "hasSettlement",
    (CASE WHEN bool_or(qft."settlingKind" AND qft.status IN (${financialTransactionStatus.enum.expected}, ${financialTransactionStatus.enum.pending}))
      THEN coalesce(sum((qft."amountMinor"::numeric / 100)) FILTER (WHERE qft.settles), 0)
      ELSE coalesce(sum((qft."amountMinor"::numeric / 100)) FILTER (WHERE qft."settlingKind" AND qft.status = ${financialTransactionStatus.enum.posted}), 0)
    END)::double precision AS "comparisonTotal",
    coalesce(sum((qft."amountMinor"::numeric / 100)) FILTER (WHERE ${sql.raw(postedRefundPredicate("qft"))}), 0)::double precision AS "postedRefundTotal",
    coalesce(bool_or(qfa.id IS NOT NULL AND ${sql.raw(settlementReferencePredicate("qft", "qfa"))}), false) AS "hasSettlementReference",
    coalesce(bool_or(${settlementPartyConflictSql(sql`qfa`, sql`qft`, sql`party.member`)}) FILTER (WHERE qft.settles AND party.member IS NOT NULL), false) AS "partyConflict",
    coalesce(bool_or(qft.charge AND coalesce(NOT (qfa.id = ANY(tender.accounts)), false)) FILTER (WHERE qft.settles), false) AS "tenderConflict"
    FROM ${settlementRows} qft
    -- includes-deleted: conflict evidence retains the allocated account; reference coverage requires liveness.
    LEFT JOIN "FinancialAccount" qfa ON qfa.id = qft."accountId"
    LEFT JOIN ${members} party ON party.id = qft."purchaseId" AND qft.settles
    LEFT JOIN ${tenders} tender ON tender.id = qft."purchaseId" AND qft.settles AND qft.charge
    GROUP BY qft."purchaseId") quality_settlements`;
  return client
    .with(
      requested,
      expenses,
      accepted,
      notices,
      settlementRows,
      settlingPurchases,
      members,
      tenders,
    )
    .select({
      id: purchase.id,
      shortcode: purchase.shortcode,
      vendorAccountId: purchase.vendorAccountId,
      date: purchase.date,
      orderId: purchase.orderId,
      statedTotal: sql<
        number | null
      >`${purchase.statedTotal}::numeric / 100`.mapWith(Number),
      spendingCategoryId: purchase.spendingCategoryId,
      spendingCategoryOrigin: purchase.spendingCategoryOrigin,
      orderEvidence: vendor.orderEvidence,
      expectsOrderId: sql<boolean>`coalesce(quality_accepted_orders."expectsOrderId", false)`,
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
      awaitingOrderDetails: sql<boolean>`quality_waiting_for_details."purchaseId" IS NOT NULL`,
    })
    .from(purchase)
    .leftJoin(vendor, and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)))
    .leftJoin(
      sql`${expenses}`,
      sql`quality_expenses."purchaseId" = ${purchase.id}`,
    )
    .leftJoin(
      sql`${accepted}`,
      sql`quality_accepted_orders."purchaseId" = ${purchase.id}`,
    )
    .leftJoin(
      sql`${notices}`,
      sql`quality_waiting_for_details."purchaseId" = ${purchase.id}`,
    )
    .leftJoin(
      settlements,
      sql`quality_settlements."purchaseId" = ${purchase.id}`,
    )
    .where(
      and(
        notDeleted(purchase),
        sql`${purchase.id} IN (SELECT id FROM ${requested})`,
      ),
    );
}
