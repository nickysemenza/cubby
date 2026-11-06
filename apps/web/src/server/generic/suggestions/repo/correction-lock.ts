import { suggestionCorrectionLock } from "~/server/db/suggestion-correction-lock-schema";
import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

/** Caller-owned transaction; acquire before domain records or projection rows. */
export async function lockCorrectionKey(db: Database, key: string) {
  // Physical writes invalidate an older serializable snapshot; a lock alone cannot.
  await repositoryQueries(db)
    .insert(suggestionCorrectionLock)
    .values({ key })
    .onConflictDoUpdate({ target: suggestionCorrectionLock.key, set: { key } });
}
