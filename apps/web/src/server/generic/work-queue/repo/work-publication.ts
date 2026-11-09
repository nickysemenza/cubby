import { getErrorMessage } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { recordCommittedChanges } from "~/server/db/helpers/core";
import {
  workPublication,
  type WorkPublicationMeta,
} from "~/server/db/work-item-schema";

const log = createLogger("work-publication");

const PUBLICATION_ID = 1;
/** Background-only changes (imports, Runs) reach a reader within this age. */
const WORK_PUBLICATION_MAX_AGE_MS = 2 * 60_000;
/** A running or failed attempt holds off others this long; a finished one doesn't. */
const ATTEMPT_RETRY_SECONDS = 60;

export type WorkPublicationRow = typeof workPublication.$inferSelect;

export async function readWorkPublication(
  db: Database,
): Promise<WorkPublicationRow | undefined> {
  const [row] = await getDb(db)
    .select()
    .from(workPublication)
    .where(eq(workPublication.id, PUBLICATION_ID));
  return row;
}

/** Missing, older than a member write it has not read, or past its age. */
export function workPublicationStale(
  row: WorkPublicationRow | undefined,
  now = new Date(),
): boolean {
  if (!row?.publishedAt) return true;
  if (row.dirtyAt && row.dirtyAt > row.publishedAt) return true;
  return (
    now.getTime() - row.publishedAt.getTime() > WORK_PUBLICATION_MAX_AGE_MS
  );
}

/**
 * A committed member write the publication has not read. Clock time after
 * commit is later than any publication snapshot that missed the write.
 */
export async function markWorkPublicationDirty(db: Database): Promise<void> {
  await getDb(db).execute(sql`
    INSERT INTO "WorkPublication" (id, "dirtyAt") VALUES (${PUBLICATION_ID}, clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET "dirtyAt" = clock_timestamp()`);
}

/**
 * Replaces the publication with the sources' current union. One attempt runs
 * at a time, so concurrent stale reads publish once; readers keep the previous
 * rows until this transaction commits. Returns whether this call published.
 */
export async function publishWorkItems(
  db: Database,
  /** Writes the rows inside the publication transaction (`insertWorkItems`). */
  insert: (tx: Database) => Promise<WorkPublicationMeta>,
): Promise<boolean> {
  const claimed = z.array(z.object({ id: z.number() })).parse(
    await getDb(db).execute(
      sql`
        INSERT INTO "WorkPublication" (id, "attemptedAt") VALUES (${PUBLICATION_ID}, clock_timestamp())
        ON CONFLICT (id) DO UPDATE SET "attemptedAt" = clock_timestamp()
        WHERE "WorkPublication"."attemptedAt" IS NULL
          OR "WorkPublication"."publishedAt" >= "WorkPublication"."attemptedAt"
          OR "WorkPublication"."attemptedAt" < clock_timestamp() - make_interval(secs => ${ATTEMPT_RETRY_SECONDS})
        RETURNING id`,
      "objects",
    ),
  );
  if (!claimed.length) return false;
  try {
    await withTransactionDatabase(db, async (tx) => {
      const meta = await insert(tx);
      // Transaction start precedes the rows' snapshot. Set in SQL: a JS Date
      // drops microseconds and would sort before this attempt's attemptedAt.
      await getDb(tx)
        .update(workPublication)
        .set({ publishedAt: sql`now()`, meta, error: null })
        .where(eq(workPublication.id, PUBLICATION_ID));
    });
  } catch (error) {
    log.error("work publication failed", { error });
    await getDb(db)
      .update(workPublication)
      .set({ error: getErrorMessage(error) })
      .where(eq(workPublication.id, PUBLICATION_ID));
    return false;
  }
  // Open Home, Work and sidebar reads refetch the new rows.
  await recordCommittedChanges(db, { workQueue: null });
  return true;
}
