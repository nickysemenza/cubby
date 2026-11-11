import { sql } from "drizzle-orm";

import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

type AdvisoryLockNamespace =
  | "account-alias"
  | "ai-evaluation-page"
  | "source"
  | "reviewed-booking"
  | "transaction-ref"
  | "purchase-settlement"
  | "transfer-pair"
  | "transfer-pair-leg"
  | "run-vendor-account"
  | "suggestion-review";

/**
 * The text a transaction lock hashes. Suggestion slots that guard the same
 * record pass this as their `lock`, so slot publication and direct locks
 * exclude each other.
 */
export const advisoryLockKey = (
  namespace: AdvisoryLockNamespace,
  key: string,
) => JSON.stringify([namespace, key]);

/**
 * Take every key's transaction lock in one statement, deduplicated and sorted
 * by JavaScript code-unit order of the hashed identity, so overlapping sets
 * cannot deadlock. The lock call is volatile, so Postgres evaluates it above
 * the ordinality sort rather than in a collation order.
 */
export async function advisoryXactLocks(
  tx: Pick<RepositoryQueryClient, "execute">,
  namespace: AdvisoryLockNamespace,
  keys: readonly string[],
): Promise<void> {
  const identities = [
    ...new Set(keys.map((key) => advisoryLockKey(namespace, key))),
  ].sort();
  if (!identities.length) return;
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(locks.key, 0))
    FROM (SELECT key, ord FROM unnest(ARRAY[${sql.join(
      identities.map((identity) => sql`${identity}`),
      sql`, `,
    )}]::text[]) WITH ORDINALITY AS keys(key, ord) ORDER BY ord) locks
  `);
}

/** Transaction locks use JSON keys to keep namespaces and values unambiguous. */
export async function advisoryXactLock(
  tx: Pick<RepositoryQueryClient, "execute">,
  namespace: AdvisoryLockNamespace,
  key: string,
): Promise<void> {
  const identity = advisoryLockKey(namespace, key);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
  );
}
