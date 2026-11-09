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
  | "run-vendor-account";

/** Transaction locks use JSON keys to keep namespaces and values unambiguous. */
export async function advisoryXactLock(
  tx: Pick<RepositoryQueryClient, "execute">,
  namespace: AdvisoryLockNamespace,
  key: string,
): Promise<void> {
  const identity = JSON.stringify([namespace, key]);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
  );
}
