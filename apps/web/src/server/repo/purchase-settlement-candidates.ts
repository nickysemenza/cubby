import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import { and, asc, desc, eq, ne, notExists, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { cents } from "~/server/repo/money";
import { getPurchaseByShortcode } from "~/server/repo/purchase";

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
  // POSITION treats source merchant text literally, including '%' and '_'.
  const merchantMatches = sql<boolean>`(
    ${purchase.vendorName !== null && purchase.vendorName.length > 0}
    AND position(lower(${purchase.vendorName ?? ""}) in lower(coalesce(${financialTransaction.merchant}, ''))) > 0
  )`;
  const exactAmount = sql<boolean>`(
    ${financialTransaction.kind} = 'purchase'
    AND ${purchase.statedTotal !== null}
    AND abs(round((${financialTransaction.amount} * 100)::numeric) - ${cents(purchase.statedTotal ?? 0)}) <= 1
  )`;
  const allocations = getDb(db)
    .select({ one: sql`1` })
    .from(financialTransactionAllocation)
    .where(
      and(
        eq(
          financialTransactionAllocation.transactionId,
          financialTransaction.id,
        ),
        notDeleted(financialTransactionAllocation),
      ),
    );

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
        sql`${financialTransaction.kind} IN ('purchase', 'refund')`,
        sql`${days} <= 45`,
        notExists(allocations),
        or(merchantMatches, exactAmount),
      ),
    )
    .orderBy(
      desc(exactAmount),
      desc(merchantMatches),
      asc(days),
      asc(financialTransaction.shortcode),
    )
    .limit(10);
}
