import { SETTLEMENT_CANDIDATE_LIMIT } from "@cubby/schemas/financial-transaction";
import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import { getPurchaseByShortcode } from "~/server/domains/purchase/repo/purchase";
import { createAppError } from "~/server/errors/app-error";

/** Eligibility and rank apply to the full live set before the advisory limit.
 * Allocation mutations remain authoritative when a suggestion is reviewed.
 */
export async function listPurchaseSettlementCandidates(
  db: Database,
  purchaseId: PurchaseShortcode,
) {
  const purchase = await getPurchaseByShortcode(db, purchaseId);
  if (!purchase)
    throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
  if (!purchase.date) return [];

  const effectiveDate = sql`coalesce(${financialTransaction.postedDate}, ${financialTransaction.transactionDate})::date`;
  const days = sql<number>`abs(${effectiveDate} - ${purchase.date}::date)`;
  const residual = sql`(${financialTransaction.amount} - (
    SELECT coalesce(sum(a.amount), 0) FROM "FinancialTransactionAllocation" a
    WHERE a."transactionId" = ${financialTransaction.id} AND a."deletedAt" IS NULL
  ))`;
  const targetAllocation = sql`EXISTS (
    SELECT 1 FROM "FinancialTransactionAllocation" a
    JOIN "Purchase" p ON p.id = a."purchaseId" AND p."deletedAt" IS NULL
    WHERE a."transactionId" = ${financialTransaction.id} AND a."deletedAt" IS NULL
      AND p.shortcode = ${purchaseId}
  )`;
  // POSITION treats source merchant text literally, including '%' and '_'.
  const merchantMatches = sql<boolean>`(
    ${purchase.vendorName !== null && purchase.vendorName.length > 0}
    AND position(lower(${purchase.vendorName ?? ""}) in lower(coalesce(${financialTransaction.merchant}, ''))) > 0
  )`;
  const exactAmount = sql<boolean>`(
    ${financialTransaction.kind} = 'purchase'
    AND ${purchase.statedTotal !== null}
    AND (abs(round((${financialTransaction.amount} * 100)::numeric) - ${cents(purchase.statedTotal ?? 0)}) <= 1
      OR abs(round((${residual} * 100)::numeric) - ${cents(purchase.statedTotal ?? 0)}) <= 1)
  )`;
  return getDb(db)
    .select({
      transactionId: financialTransaction.shortcode,
      days,
      merchantMatches,
      exactAmount,
    })
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      eq(financialAccount.id, financialTransaction.accountId),
    )
    .where(
      and(
        notDeleted(financialTransaction),
        notDeleted(financialAccount),
        ne(financialTransaction.status, "void"),
        isNull(financialTransaction.ledgerTransferId),
        sql`${financialTransaction.kind} IN ('purchase', 'refund')`,
        sql`${days} <= 45`,
        sql`((${residual} <> 0 AND sign(${residual}) = sign(${financialTransaction.amount})) OR ${targetAllocation})`,
      ),
    )
    .orderBy(
      desc(exactAmount),
      desc(merchantMatches),
      asc(days),
      asc(financialTransaction.shortcode),
    )
    .limit(SETTLEMENT_CANDIDATE_LIMIT);
}
