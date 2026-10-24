import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentCorrectionLock } from "~/server/db/schema";

/** Caller-owned transaction; acquire before domain records or projection rows. */
export async function lockCorrectionKey(db: Database, key: string) {
  // Physical writes invalidate an older serializable snapshot; a lock alone cannot.
  await getDb(db)
    .insert(assessmentCorrectionLock)
    .values({ key })
    .onConflictDoUpdate({ target: assessmentCorrectionLock.key, set: { key } });
}
