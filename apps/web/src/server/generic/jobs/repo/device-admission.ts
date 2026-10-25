import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  JOB_BACKFILL_SHARE,
  jobRunOwned,
} from "~/server/generic/jobs/repo/jobs";

/**
 * Device pulls claim one Job at a time but keep the drain's two classes: an
 * active, member-visible Run's parked work (`jobRunOwned`) leads, and after
 * this many run-owned device services in a row backfill is owed the next.
 */
export const DEVICE_OWNED_STREAK = Math.ceil(1 / JOB_BACKFILL_SHARE) - 1;

/**
 * How many of the latest device services in a row were run-owned, up to
 * `DEVICE_OWNED_STREAK`. A service is a claim handed over to a device (an
 * `ImageProcessingAttempt` of `image.device` work), so each reclaim of one
 * row counts; ownership is selection's own definition, evaluated now.
 */
export async function deviceOwnedStreak(db: Database): Promise<number> {
  const result = await repositoryQueries(db).execute<{ owned: boolean }>(sql`
    SELECT ${jobRunOwned()} AS owned
    FROM "ImageProcessingAttempt" a
    JOIN "ImageProcessingJob" p ON p.id = a."jobId"
    JOIN "Job" ON "Job".key = 'image-processing:' || p.id::text
    WHERE "Job".kind = 'image.device'
    ORDER BY a."startedAt" DESC, a.id DESC
    LIMIT ${DEVICE_OWNED_STREAK}`);
  let streak = 0;
  for (const row of result.rows) {
    if (!row.owned) break;
    streak++;
  }
  return streak;
}

/** Whether the next device pull owes backfill its turn. */
export const deviceBackfillTurn = (streak: number) =>
  streak >= DEVICE_OWNED_STREAK;

/**
 * Pulls served before the `classPosition`-th (1-based) parked Job of its
 * class, claiming one at a time from the current `streak` the way device
 * claims do. Ignores a device's preference for work another device last
 * ran, which only reorders that device's own pull.
 */
export function deviceSelectionIndex(
  job: { runOwned: boolean; classPosition: number },
  totals: { owned: number; backfill: number },
  streak: number,
): number {
  let owned = 0;
  let backfill = 0;
  let run = streak;
  while (owned < totals.owned || backfill < totals.backfill) {
    const backfillNext =
      backfill < totals.backfill &&
      (owned >= totals.owned || deviceBackfillTurn(run));
    if (backfillNext) {
      if (!job.runOwned && job.classPosition === backfill + 1)
        return owned + backfill;
      backfill++;
      run = 0;
    } else {
      if (job.runOwned && job.classPosition === owned + 1)
        return owned + backfill;
      owned++;
      run++;
    }
  }
  return owned + backfill;
}
