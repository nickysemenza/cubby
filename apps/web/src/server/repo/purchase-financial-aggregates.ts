import type { PurchaseId } from "@cubby/schemas/identifiers";
import { and, inArray, ne, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { financialTransaction } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export type PurchaseFinancialAggregate = {
  transactionCount: number;
  postedTransactionCount: number;
  outstandingTransactionCount: number;
  postedTotal: number;
  projectedTotal: number;
};

export const emptyPurchaseFinancialAggregate =
  (): PurchaseFinancialAggregate => ({
    transactionCount: 0,
    postedTransactionCount: 0,
    outstandingTransactionCount: 0,
    postedTotal: 0,
    projectedTotal: 0,
  });

/** One grouped scan for every requested purchase's non-void settlement rows. */
export async function loadPurchaseFinancialAggregates(
  db: Database | DrizzleTransaction,
  purchaseIds: readonly PurchaseId[],
): Promise<Map<PurchaseId, PurchaseFinancialAggregate>> {
  if (purchaseIds.length === 0) return new Map();

  const rows = await unwrapDb(db)
    .select({
      purchaseId: financialTransaction.purchaseId,
      transactionCount: sql<number>`count(*)::int`,
      postedTransactionCount: sql<number>`count(*) FILTER (WHERE ${financialTransaction.status} = 'posted')::int`,
      outstandingTransactionCount: sql<number>`count(*) FILTER (WHERE ${financialTransaction.status} IN ('expected', 'pending'))::int`,
      postedTotal: sql<number>`COALESCE(sum(${financialTransaction.amount}) FILTER (WHERE ${financialTransaction.status} = 'posted'), 0)::double precision`,
      projectedTotal: sql<number>`COALESCE(sum(${financialTransaction.amount}), 0)::double precision`,
    })
    .from(financialTransaction)
    .where(
      and(
        inArray(financialTransaction.purchaseId, [...purchaseIds]),
        notDeleted(financialTransaction),
        ne(financialTransaction.status, "void"),
      ),
    )
    .groupBy(financialTransaction.purchaseId);

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
              },
            ] as const,
          ]
        : [],
    ),
  );
}
