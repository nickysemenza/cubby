import { assessmentCorrectionLock } from "~/server/db/assessment-correction-lock-schema";
import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

/** Caller-owned transaction; acquire before domain records or projection rows. */
export async function lockCorrectionKey(db: Database, key: string) {
  // Physical writes invalidate an older serializable snapshot; a lock alone cannot.
  await repositoryQueries(db)
    .insert(assessmentCorrectionLock)
    .values({ key })
    .onConflictDoUpdate({ target: assessmentCorrectionLock.key, set: { key } });
}

/** The field gate stabilizes alias discovery, including proof committed on another record. */
export async function lockFieldCorrectionScope(
  db: Database,
  entity: string,
  field: string,
) {
  await lockCorrectionKey(db, `field-correction-scope:${entity}:${field}`);
}
