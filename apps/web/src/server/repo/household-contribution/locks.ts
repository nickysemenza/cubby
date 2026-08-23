import type {
  FinancialAccountId,
  FinancialTransactionId,
} from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { DrizzleTransaction } from "~/server/db";

type FundingEvidenceLockTargets = {
  transactionIds?: readonly FinancialTransactionId[];
  accountIds?: readonly FinancialAccountId[];
};

/**
 * Serializes every write that can create or invalidate funding-transfer
 * evidence. Transaction keys sort before account keys so callers may discover
 * the current accounts only after locking the transactions without creating an
 * account/transaction ABBA cycle.
 */
export async function lockFundingEvidenceMutationTargets(
  tx: DrizzleTransaction,
  targets: FundingEvidenceLockTargets,
): Promise<void> {
  const keys = uniq([
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
