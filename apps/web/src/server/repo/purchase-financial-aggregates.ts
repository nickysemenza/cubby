import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import type { PurchaseId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
// Type-only back-edge from that module to this one, so this value import creates
// no runtime cycle.
import { postedRefundPredicate } from "~/server/repo/financial-reconciliation";

export type PurchaseFinancialAggregate = {
  transactionCount: number;
  postedTransactionCount: number;
  outstandingTransactionCount: number;
  postedTotal: number;
  projectedTotal: number;
  postedRefundTotal: number;
};

export const emptyPurchaseFinancialAggregate =
  (): PurchaseFinancialAggregate => ({
    transactionCount: 0,
    postedTransactionCount: 0,
    outstandingTransactionCount: 0,
    postedTotal: 0,
    projectedTotal: 0,
    postedRefundTotal: 0,
  });

/** One grouped scan for every requested purchase's non-void settlement rows. */
export async function loadPurchaseFinancialAggregates(
  db: Database | DrizzleTransaction,
  purchaseIds: readonly PurchaseId[],
): Promise<Map<PurchaseId, PurchaseFinancialAggregate>> {
  if (purchaseIds.length === 0) return new Map();

  const rows = await unwrapDb(db)
    .select({
      purchaseId: financialTransactionAllocation.purchaseId,
      // Counts stay TRANSACTION counts, not allocation counts, so
      // `calculateFinancialReconciliation`'s `comparable = transactionCount > 0`
      // gate and its outstanding/projected choice keep their meaning — and so
      // every downstream consumer needs no edit. `DISTINCT` matters only for a
      // hypothetical duplicate pair, which the partial unique index forbids, but
      // it states the intent.
      transactionCount: sql<number>`count(DISTINCT ${financialTransactionAllocation.transactionId})::int`,
      postedTransactionCount: sql<number>`count(DISTINCT ${financialTransactionAllocation.transactionId}) FILTER (WHERE ${financialTransaction.status} = 'posted')::int`,
      outstandingTransactionCount: sql<number>`count(DISTINCT ${financialTransactionAllocation.transactionId}) FILTER (WHERE ${financialTransaction.status} IN ('expected', 'pending'))::int`,
      // Totals sum the ALLOCATION, i.e. this purchase's share. Summing the whole
      // transaction amount would credit a split charge in full to every purchase
      // it touched and report a mismatch on all of them.
      postedTotal: sql<number>`COALESCE(sum(${financialTransactionAllocation.amount}) FILTER (WHERE ${financialTransaction.status} = 'posted'), 0)::double precision`,
      projectedTotal: sql<number>`COALESCE(sum(${financialTransactionAllocation.amount}), 0)::double precision`,
      postedRefundTotal: sql<number>`COALESCE(sum(${financialTransactionAllocation.amount}) FILTER (WHERE ${sql.raw(postedRefundPredicate('"FinancialTransaction"'))}), 0)::double precision`,
    })
    .from(financialTransactionAllocation)
    .innerJoin(
      financialTransaction,
      eq(financialTransaction.id, financialTransactionAllocation.transactionId),
    )
    .where(
      and(
        inArray(financialTransactionAllocation.purchaseId, [...purchaseIds]),
        notDeleted(financialTransactionAllocation),
        inArray(financialTransaction.kind, [...purchaseSettlementKinds]),
        notDeleted(financialTransaction),
        ne(financialTransaction.status, "void"),
      ),
    )
    .groupBy(financialTransactionAllocation.purchaseId);

  return new Map(
    rows.flatMap((row) =>
      row.purchaseId
        ? [
            [
              row.purchaseId,
              {
                transactionCount: Number(row.transactionCount),
                postedTransactionCount: Number(row.postedTransactionCount),
                outstandingTransactionCount: Number(
                  row.outstandingTransactionCount,
                ),
                postedTotal: Number(row.postedTotal),
                projectedTotal: Number(row.projectedTotal),
                postedRefundTotal: Number(row.postedRefundTotal),
              },
            ] as const,
          ]
        : [],
    ),
  );
}
