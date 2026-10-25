import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { JOB_BACKFILL_SHARE } from "~/server/generic/jobs/repo/jobs";

/**
 * Device pulls claim one Job at a time but keep the drain's two classes: an
 * active, member-visible Run's parked work (`jobRunOwned`) leads, and after
 * this many run-owned device services in a row backfill is owed the next.
 */
const DEVICE_OWNED_STREAK = Math.ceil(1 / JOB_BACKFILL_SHARE) - 1;

const DEVICE_LANE = "image.device";

/**
 * How many device claims in a row were run-owned when admitted, for queue
 * positions. Each claim, reclaims included, is one service; a claim the
 * server cannot hand over is undone by `refuseDeviceAdmission`.
 */
export async function deviceOwnedStreak(db: Database): Promise<number> {
  const result = await repositoryQueries(db).execute<{ streak: number }>(sql`
    SELECT "ownedStreak" AS streak FROM "JobLaneAdmission"
    WHERE lane = ${DEVICE_LANE}`);
  return result.rows[0]?.streak ?? 0;
}

/**
 * Locks the device lane's admission row for the claim's transaction, so
 * concurrent pulls take their turns one at a time, and returns its streak.
 */
export async function lockDeviceAdmission(db: Database): Promise<number> {
  const result = await repositoryQueries(db).execute<{ streak: number }>(sql`
    INSERT INTO "JobLaneAdmission" (lane) VALUES (${DEVICE_LANE})
    ON CONFLICT (lane) DO UPDATE SET lane = EXCLUDED.lane
    RETURNING "ownedStreak" AS streak`);
  return result.rows[0]?.streak ?? 0;
}

/** What a refused hand-off needs to undo its claim's admission exactly. */
export type DeviceAdmission = {
  runOwned: boolean;
  /** The streak this claim replaced. */
  priorStreak: number;
  /** Backfill admissions so far, this claim's included. */
  backfillAdmissions: number;
};

/** Counts one admitted claim by the class it was admitted under. */
export async function recordDeviceAdmission(
  db: Database,
  runOwned: boolean,
  priorStreak: number,
): Promise<DeviceAdmission> {
  const result = await repositoryQueries(db).execute<{ backfill: string }>(sql`
    UPDATE "JobLaneAdmission"
    SET "ownedStreak" = ${runOwned ? sql`"ownedStreak" + 1` : sql`0`},
      "backfillAdmissions" = "backfillAdmissions" + ${runOwned ? 0 : 1},
      "updatedAt" = now()
    WHERE lane = ${DEVICE_LANE}
    RETURNING "backfillAdmissions" AS backfill`);
  return {
    runOwned,
    priorStreak,
    backfillAdmissions: Number(result.rows[0]?.backfill ?? 0),
  };
}

/**
 * Undoes the admission of a claim the server could not hand over, in its
 * release's transaction, as if the claim had never been admitted. While no
 * backfill was admitted since, only Run claims were (each adding one): a
 * refused Run claim takes back its own one, and a refused backfill restores
 * the streak it reset plus those Run claims. A backfill admitted since
 * already spent the turn, so the streak stands.
 */
export async function refuseDeviceAdmission(
  db: Database,
  admission: DeviceAdmission,
) {
  await repositoryQueries(db).execute(sql`
    UPDATE "JobLaneAdmission"
    SET "ownedStreak" = ${
      admission.runOwned
        ? sql`greatest("ownedStreak" - 1, 0)`
        : sql`"ownedStreak" + ${admission.priorStreak}`
    },
      "updatedAt" = now()
    WHERE lane = ${DEVICE_LANE}
      AND "backfillAdmissions" = ${admission.backfillAdmissions}`);
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
