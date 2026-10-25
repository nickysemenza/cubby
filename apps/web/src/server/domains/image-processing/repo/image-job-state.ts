import {
  imageProcessingJobState,
  type ImageProcessingJobState,
} from "@cubby/schemas/image-processing";
import { JOB_NEEDS_ATTENTION_ATTEMPTS, jobState } from "@cubby/schemas/job";
import { sql, type SQL } from "drizzle-orm";

const STATE = imageProcessingJobState.enum;

/**
 * The displayed state of an image job, derived from its universal Job. The
 * row stores only the domain outcome (`pending` while open, `ready`,
 * `skipped`); the Job owns execution, so no second state machine can drift:
 *
 * - `leased`: an attempt holds a live lease;
 * - `failed`: open work that failed `JOB_NEEDS_ATTENTION_ATTEMPTS` times in a
 *   row, or whose execution stopped — it needs attention but keeps retrying;
 * - `waiting_for_device`: parked for an Apple device;
 * - `pending`: queued for the server, or backing off.
 *
 * A stored `failed` is a legacy terminal state of a superseded processor.
 */
export const imageJobDisplayStateSql = (
  // Qualified by hand: a bare `id` inside the Job subquery would be the Job's.
  row: { id: SQL; state: SQL } = {
    id: sql`"ImageProcessingJob".id`,
    state: sql`"ImageProcessingJob".state`,
  },
) => sql<ImageProcessingJobState>`(CASE
  WHEN ${row.state} <> ${STATE.pending} THEN ${row.state}
  ELSE coalesce((SELECT CASE
    WHEN dj.state = ${jobState.enum.running} AND dj."leaseExpiresAt" > ${new Date().toISOString()}::timestamp THEN ${STATE.leased}
    WHEN dj.state IN (${jobState.enum.failed}, ${jobState.enum.cancelled}, ${jobState.enum.paused})
      OR dj.attempts >= ${JOB_NEEDS_ATTENTION_ATTEMPTS} THEN ${STATE.failed}
    WHEN dj.kind = 'image.device' THEN ${STATE.waiting_for_device}
    ELSE ${STATE.pending} END
    FROM "Job" dj WHERE dj.key = 'image-processing:' || ${row.id}::text), ${STATE.pending})
END)`;
