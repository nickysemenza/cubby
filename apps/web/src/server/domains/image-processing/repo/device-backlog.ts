import { jobState } from "@cubby/schemas/job";
import { sql } from "drizzle-orm";

import type { DeviceBacklog } from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { externalJobDue } from "~/server/generic/jobs/repo/external-claim";

const DEVICE_LANE = "image.device";

/** Claims and working devices are counted over this recent window. */
const WINDOW_MINUTES = 10;

/**
 * Parked Apple-device work at a glance: how many Jobs wait, how many Runs
 * they hold up, which devices worked the lane recently and the ETA at that
 * pace. Every device attempt started in the window is a claim, reclaims
 * included (`Job.lastClaimedAt` keeps only the latest), and a device counts
 * as working when it started one. ETA uses accepted successful completions
 * for current image sources, not claims or intermediate normalization;
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
    completions: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM "Job"
        WHERE kind = ${DEVICE_LANE} AND ${externalJobDue(now)}) AS waiting,
      (SELECT count(DISTINCT p."runId")::int FROM "Job"
        JOIN "ImageProcessingJob" p ON "Job".key = 'image-processing:' || p.id::text
        WHERE "Job".kind = ${DEVICE_LANE}
          AND "Job".state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running})
          AND p."runId" IS NOT NULL) AS runs,
      device_attempts.claims, device_attempts.devices,
      (SELECT count(DISTINCT a."jobId")::int
        FROM "ImageProcessingAttempt" a
        JOIN "ImageProcessingJob" p ON p.id = a."jobId"
        JOIN "Image" i ON i.id = p."imageId"
        WHERE a.executor->>${"kind"} = ${"device"}
          AND a.state = ${"ready"}
          AND a.result->>${"status"} = ${"completed"}
          AND a."completedAt" > ${windowStart} AND a."completedAt" <= ${at}
          AND p.state = ${"ready"} AND ${notDeleted("p")}
          AND ${notDeleted("i")} AND i.status = ${"UPLOADED"}
          AND i.sha256 = p."sourceContentHash") AS completions
    FROM (SELECT count(*)::int AS claims,
        count(DISTINCT a.executor->>${"deviceId"})::int AS devices
      FROM "ImageProcessingAttempt" a
      WHERE a.executor->>${"kind"} = ${"device"}
        AND a."startedAt" > ${windowStart}) device_attempts`);
  const row = result.rows[0] ?? {
    waiting: 0,
    runs: 0,
    claims: 0,
    devices: 0,
    completions: 0,
  };
  const claimsPerMinute = row.claims / WINDOW_MINUTES;
  const completionsPerMinute = row.completions / WINDOW_MINUTES;
  return {
    waiting: row.waiting,
    runsWaiting: row.runs,
    workingDevices: row.devices,
    claimsPerMinute,
    etaSeconds:
      row.waiting > 0 && completionsPerMinute > 0
        ? Math.round((row.waiting / completionsPerMinute) * 60)
        : null,
  };
}
