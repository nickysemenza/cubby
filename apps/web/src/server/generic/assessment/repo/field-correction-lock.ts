import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentCorrectionLock } from "~/server/db/schema";

/** Must run inside the caller's write transaction, before source/target row locks. */
export async function lockFieldCorrectionKey(db: Database, key: string) {
  // A physical update is intentional: a lock alone cannot invalidate an older
  // serializable snapshot when a conflicting root commits on another record.
  await getDb(db)
    .insert(assessmentCorrectionLock)
    .values({ key })
    .onConflictDoUpdate({ target: assessmentCorrectionLock.key, set: { key } });
}
