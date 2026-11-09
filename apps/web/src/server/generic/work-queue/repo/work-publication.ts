import { getErrorMessage } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
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
/** A failed attempt holds off the next one this long. */
const FAILED_RETRY_SECONDS = 60;
/** Publishers hold this transaction lock; at most one runs at a time. */
const PUBLISH_LOCK = "work-publication";

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
 * Replaces the publication with the sources' current union. A transaction
 * try-lock admits one publisher; another returns at once, and readers never
 * wait, keeping the previous rows until this transaction commits. The insert
 * runs in a savepoint, so its failure is recorded by the attempt that still
 * holds the lock. Returns whether this call published.
 */
export async function publishWorkItems(
  db: Database,
  /** Writes the rows inside the publication transaction (`insertWorkItems`). */
  insert: (tx: Database) => Promise<WorkPublicationMeta>,
): Promise<boolean> {
  const published = await withTransactionDatabase(db, async (tx) => {
    const { locked } = z
      .object({ locked: z.boolean() })
      .parse(
        (
          await getDb(tx).execute(
            sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${PUBLISH_LOCK}, 0)) AS locked`,
            "objects",
          )
        )[0],
      );
    if (!locked) return false;
    const [backoff] = await getDb(tx)
      .select({ id: workPublication.id })
      .from(workPublication)
      .where(
        and(
          eq(workPublication.id, PUBLICATION_ID),
          sql`${workPublication.attemptedAt} > clock_timestamp() - make_interval(secs => ${FAILED_RETRY_SECONDS})`,
        ),
      );
    if (backoff) return false;
    const record = (
      values: Omit<PgInsertValue<typeof workPublication>, "id">,
    ) =>
      getDb(tx)
        .insert(workPublication)
        .values({ id: PUBLICATION_ID, ...values })
        .onConflictDoUpdate({ target: workPublication.id, set: values });
    try {
      const meta = await withTransactionDatabase(tx, insert);
      // Transaction start precedes the rows' snapshot. Set in SQL: a JS Date
      // drops microseconds and could sort before a later dirtyAt it read.
      await record({
        publishedAt: sql`now()`,
        meta,
        error: null,
        attemptedAt: null,
      });
      return true;
    } catch (error) {
      log.error("work publication failed", { error });
      await record({
        error: getErrorMessage(error),
        attemptedAt: sql`clock_timestamp()`,
      });
      return false;
    }
  });
  // Open Home, Work and sidebar reads refetch the new rows.
  if (published) await recordCommittedChanges(db, { workQueue: null });
  return published;
}
