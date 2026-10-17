import { SETTLEMENT_CANDIDATE_LIMIT } from "@cubby/schemas/financial-transaction";
import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, asc, desc, eq, isNull, ne, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import {
  type SettlementConflictKind,
  settlementConflictKinds,
  settlementConflictSql,
} from "~/server/domains/financial-transaction/repo/settlement-conflicts";
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
  const centsOff = (amount: SQL) =>
    sql`abs(round((${amount} * 100)::numeric) - ${cents(purchase.statedTotal ?? 0)})`;
  const amountWithin = (centsAllowed: number) => sql<boolean>`(
    ${financialTransaction.kind} = 'purchase'
    AND ${purchase.statedTotal !== null}
    AND (${centsOff(sql`${financialTransaction.amount}`)} <= ${centsAllowed}
      OR ${centsOff(residual)} <= ${centsAllowed})
  )`;
  const exactAmount = amountWithin(0);
  const nearAmount = sql<boolean>`(${amountWithin(1)} AND NOT ${exactAmount})`;
  const conflictWith = (kind: SettlementConflictKind) => sql<boolean>`EXISTS (
    SELECT 1 FROM "Purchase" settle_target
    WHERE settle_target.shortcode = ${purchaseId}
      AND settle_target."deletedAt" IS NULL
      AND ${settlementConflictSql(kind, {
        purchase: "settle_target",
        account: '"FinancialAccount"',
        transaction: '"FinancialTransaction"',
      })}
  )`;
  const partyConflict = conflictWith("party");
  const tenderConflict = conflictWith("tender");
  const conflicted = sql<boolean>`(${partyConflict} OR ${tenderConflict})`;
  const rows = await getDb(db)
    .select({
      transactionId: financialTransaction.shortcode,
      days,
      merchantMatches,
      exactAmount,
      nearAmount,
      partyConflict,
      tenderConflict,
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
      asc(conflicted),
      desc(exactAmount),
      desc(nearAmount),
      desc(merchantMatches),
      asc(days),
      asc(financialTransaction.shortcode),
    )
    .limit(SETTLEMENT_CANDIDATE_LIMIT);
  return rows.map(({ partyConflict, tenderConflict, ...row }) => ({
    ...row,
    conflicts: settlementConflictKinds.filter((kind) =>
      kind === "party" ? partyConflict : tenderConflict,
    ),
  }));
}
