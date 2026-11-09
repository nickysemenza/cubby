import { sql } from "drizzle-orm";

import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

type AdvisoryLockNamespace =
  | "account-alias"
  | "source"
  | "reviewed-booking"
  | "transaction-ref"
  | "purchase-settlement"
  | "transfer-pair"
  | "transfer-pair-leg"
  | "run-vendor-account"
  | "coordinator-turn";

/**
 * The text a transaction lock hashes. Suggestion slots that guard the same
 * record pass this as their `lock`, so slot publication and direct locks
 * exclude each other.
 */
export const advisoryLockKey = (
  namespace: AdvisoryLockNamespace,
  key: string,
) => JSON.stringify([namespace, key]);

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
