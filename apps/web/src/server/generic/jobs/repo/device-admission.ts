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
const DEVICE_OWNED_STREAK = Math.ceil(1 / JOB_BACKFILL_SHARE) - 1;

const DEVICE_LANE = "image.device";

/**
 * How many device services in a row were run-owned, up to
 * `DEVICE_OWNED_STREAK`, for queue positions. A service is a hand-off that
 * committed: an assigned attempt of `image.device` work, reclaims included.
 */
export async function deviceOwnedStreak(db: Database): Promise<number> {
  const result = await repositoryQueries(db).execute<{ streak: number }>(sql`
    SELECT "ownedStreak" AS streak FROM "JobLaneAdmission"
    WHERE lane = ${DEVICE_LANE}`);
  return result.rows[0]?.streak ?? 0;
}

/**
 * Locks the device lane's admission row until the caller's transaction ends
 * and returns its streak. A device pull holds it from choosing a class
 * through the hand-off, so concurrent pulls take their turns one at a time.
 */
export async function lockDeviceAdmission(db: Database): Promise<number> {
  const result = await repositoryQueries(db).execute<{ streak: number }>(sql`
    INSERT INTO "JobLaneAdmission" (lane) VALUES (${DEVICE_LANE})
    ON CONFLICT (lane) DO UPDATE SET lane = EXCLUDED.lane
    RETURNING "ownedStreak" AS streak`);
  return result.rows[0]?.streak ?? 0;
}

/**
 * Counts one committed device hand-off of the `image.device` Job `key`, by
 * its class now (`jobRunOwned`), in the assignment's transaction: only a
 * hand-off that commits is a service, and a Run ending later never
 * reclassifies it. A refused or failed hand-off writes nothing.
 */
export async function recordDeviceService(db: Database, key: string) {
  await lockDeviceAdmission(db);
  await repositoryQueries(db).execute(sql`
    UPDATE "JobLaneAdmission"
    SET "ownedStreak" = CASE WHEN served.owned
        THEN least("ownedStreak" + 1, ${DEVICE_OWNED_STREAK}) ELSE 0 END,
      "updatedAt" = now()
    FROM (SELECT ${jobRunOwned()} AS owned FROM "Job"
      WHERE "Job".key = ${key} AND "Job".kind = ${DEVICE_LANE}) served
    WHERE lane = ${DEVICE_LANE}`);
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
