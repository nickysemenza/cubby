import { jobState } from "@cubby/schemas/job";
import { sql } from "drizzle-orm";

import type { DeviceBacklog } from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { jobDue } from "~/server/generic/jobs/repo/jobs";

const DEVICE_LANE = "image.device";

/** Claims and working devices are counted over this recent window. */
const WINDOW_MINUTES = 10;

/**
 * Parked Apple-device work at a glance: how many Jobs wait, how many Runs
 * they hold up, which devices worked the lane recently and the ETA at that
 * pace. A device counts as working when it claimed an attempt in the window;
 * `Device.lastSeenAt` only moves on hello, so it cannot say who is pulling.
 */
export async function readDeviceBacklog(
  db: Database,
  now = new Date(),
): Promise<DeviceBacklog> {
  const at = sql`${now.toISOString()}::timestamp`;
  const windowStart = sql`${at} - ${WINDOW_MINUTES} * interval '1 minute'`;
  const result = await repositoryQueries(db).execute<{
    waiting: number;
    runs: number;
    claims: number;
    devices: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM "Job"
        WHERE kind = ${DEVICE_LANE} AND ${jobDue(now)}) AS waiting,
      (SELECT count(DISTINCT p."runId")::int FROM "Job"
        JOIN "ImageProcessingJob" p ON "Job".key = 'image-processing:' || p.id::text
        WHERE "Job".kind = ${DEVICE_LANE}
          AND "Job".state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running})
          AND p."runId" IS NOT NULL) AS runs,
      (SELECT count(*)::int FROM "Job"
        WHERE kind = ${DEVICE_LANE} AND "lastClaimedAt" > ${windowStart}) AS claims,
      (SELECT count(DISTINCT a.executor->>${"deviceId"})::int
        FROM "ImageProcessingAttempt" a
        WHERE a.executor->>${"kind"} = ${"device"}
          AND a."startedAt" > ${windowStart}) AS devices`);
  const row = result.rows[0] ?? { waiting: 0, runs: 0, claims: 0, devices: 0 };
  const claimsPerMinute = row.claims / WINDOW_MINUTES;
  return {
    waiting: row.waiting,
    runsWaiting: row.runs,
    workingDevices: row.devices,
    claimsPerMinute,
    etaSeconds:
      row.waiting > 0 && claimsPerMinute > 0
        ? Math.round((row.waiting / claimsPerMinute) * 60)
        : null,
  };
}
