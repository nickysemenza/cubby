import { sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";

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
  namespace: "account-alias" | "transaction-ref",
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
