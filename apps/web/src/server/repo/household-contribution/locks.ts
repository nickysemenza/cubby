import type {
  FinancialAccountId,
  FinancialTransactionId,
  FundingSourceId,
  FundingTransferId,
} from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { DrizzleTransaction } from "~/server/db";

type FundingEvidenceLockTargets = {
  sourceIds?: readonly FundingSourceId[];
  transferIds?: readonly FundingTransferId[];
  transactionIds?: readonly FinancialTransactionId[];
  accountIds?: readonly FinancialAccountId[];
};

/**
 * Serializes writes that can create or invalidate household funding edges.
 * Callers acquire sources, transfers, transactions, then accounts. The negative
 * prefixes preserve the already-deployed transaction/account keys while
 * extending their order.
 */
export async function lockFundingEvidenceMutationTargets(
  tx: DrizzleTransaction,
  targets: FundingEvidenceLockTargets,
): Promise<void> {
  const keys = uniq([
    ...(targets.sourceIds ?? []).map(
      (id) => `household-funding-evidence:-2-source:${id}`,
    ),
    ...(targets.transferIds ?? []).map(
      (id) => `household-funding-evidence:-1-transfer:${id}`,
    ),
    ...(targets.transactionIds ?? []).map(
      (id) => `household-funding-evidence:0-transaction:${id}`,
    ),
    ...(targets.accountIds ?? []).map(
      (id) => `household-funding-evidence:1-account:${id}`,
    ),
  ]).sort();
  for (const key of keys) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
}

/**
 * Household ledger topology is small and writes are rare. Taking one lock before
 * any Person/Expense row or scoped funding lock prevents FK key-share/row-lock
 * cycles while still leaving ordinary FinancialTransaction writes independent.
 */
export async function lockHouseholdLedgerTopology(
  tx: DrizzleTransaction,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('household-ledger-topology', 0))`,
  );
}
