import { moneyToMinor } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { createAppError } from "~/server/errors/app-error";

/**
 * Serialize source-owned financial identities before checking their JSONB
 * uniqueness. The rows do not exist yet, so there is nothing useful to lock;
 * a transaction-scoped advisory lock gives every app write the same atomic
 * check-then-write boundary without normalizing the evidence arrays solely to
 * obtain a unique index.
 *
 * Keys are sorted before locking so two writes carrying the same set in a
 * different order cannot deadlock each other.
 */
export async function lockFinancialEvidenceKeys(
  tx: DrizzleTransaction,
  namespace: "account-alias" | "source" | "reviewed-booking",
  keys: readonly string[],
): Promise<void> {
  // JSON escaping keeps evidence values containing NUL delimiters valid UTF-8
  // bind parameters while retaining an unambiguous namespace/key boundary.
  const lockKeys = uniq(
    keys.map((key) => JSON.stringify([namespace, key])),
  ).sort();
  for (const key of lockKeys) {
    await unwrapDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
}

/** Legacy evidence doubles must refuse through the financial constraint boundary. */
export const financialEvidenceAmountMinor = (amount: number): bigint => {
  try {
    return moneyToMinor(amount);
  } catch {
    // SILENT: Replace the low-level conversion error with the owning financial constraint.
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Financial evidence amount must be an exact, supported whole-cent amount.",
    );
  }
};
