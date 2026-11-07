import {
  imageProcessingJobState,
  type ImageProcessingJobState,
} from "@cubby/schemas/image-processing";
import {
  JOB_NEEDS_ATTENTION_ATTEMPTS,
  jobWaitingOnReason,
  jobWaitReason,
  type JobWaitingOn,
  type JobWaitingOnReason,
} from "@cubby/schemas/job";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { imageProcessingJob } from "~/server/db/image-processing-schema";

const STATE = imageProcessingJobState.enum;

/** Who executes a row: Cubby's server drain or an Apple device's pull. */
export type ImageProcessingLane = "cloud" | "device";

const column = (alias: string, name: string) =>
  sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
const at = (now: Date) => sql`${now.toISOString()}::timestamp`;

/**
 * The displayed state of an image job. The row stores the domain outcome
 * (`pending` while open, `ready`, `skipped`, or deterministic `failed`) and its execution columns:
 *
 * - `leased`: an attempt holds a live lease;
 * - `failed`: open work that failed `JOB_NEEDS_ATTENTION_ATTEMPTS` times in a
 *   row; it needs attention but keeps retrying;
 * - `waiting_for_device`: parked for an Apple device;
 * - `pending`: queued for the server, or backing off.
 *
 * A stored `failed` retains a nonretryable result until explicit retry or new inputs.
 */
export const imageJobDisplayStateSql = (alias = "ImageProcessingJob") => {
  const c = (name: string) => column(alias, name);
  return sql<ImageProcessingJobState>`(CASE
  WHEN ${c("state")} <> ${STATE.pending} THEN ${c("state")}
  WHEN ${c("leaseUntil")} > ${at(new Date())} THEN ${STATE.leased}
  WHEN ${c("failures")} >= ${JOB_NEEDS_ATTENTION_ATTEMPTS} THEN ${STATE.failed}
  WHEN ${c("lane")} = ${"device"} THEN ${STATE.waiting_for_device}
  ELSE ${STATE.pending} END)`;
};

/** Open work an executor may take now: due, or holding a lapsed lease. */
export const imageJobClaimable = (now: Date) =>
  and(
    eq(imageProcessingJob.state, STATE.pending),
    or(
      and(
        isNull(imageProcessingJob.leaseUntil),
        lte(imageProcessingJob.runAt, now),
      ),
      lte(imageProcessingJob.leaseUntil, now),
    ),
  );

/** Open rows by what they wait on, for Run rollups over many rows. */
export const imageJobWaitingOnReasonSql = (alias: string, now: Date) => {
  const c = (name: string) => column(alias, name);
  const R = jobWaitingOnReason.enum;
  return sql<JobWaitingOnReason>`(CASE
    WHEN ${c("leaseUntil")} IS NOT NULL THEN ${R.leased}
    WHEN ${c("waitReason")} = ${jobWaitReason.enum.ai_funding_window} THEN ${R.waiting_funding}
    WHEN ${c("waitReason")} = ${jobWaitReason.enum.device} AND ${c("runAt")} > ${at(now)}
      THEN CASE WHEN ${c("lane")} = ${"device"} THEN ${R.waiting_device} ELSE ${R.blocked} END
    WHEN ${c("runAt")} > ${at(now)} THEN ${R.backing_off}
    WHEN ${c("lane")} = ${"device"} THEN ${R.waiting_device}
    ELSE ${R.due} END)::text`;
};

/** What one open row waits on, in the shape every waiting-on surface reads. */
export function imageJobWaitingOn(
  row: Pick<
    typeof imageProcessingJob.$inferSelect,
    "lane" | "runAt" | "leaseUntil" | "failures" | "waitReason" | "lastError"
  >,
  now: Date,
  executor: { name: string | null; deviceId: string | null } | null = null,
): JobWaitingOn {
  const lane = row.lane === "device" ? "apple_device" : "frontier_ai";
  const device = { reason: "waiting_device", lane: "apple_device" } as const;
  if (row.leaseUntil)
    return {
      reason: "leased",
      lane,
      executor:
        executor?.name ?? (row.lane === "cloud" ? "Cubby server" : null),
      executorDeviceId: executor?.deviceId ?? null,
      leasedAt: null,
      leaseExpiresAt: row.leaseUntil.toISOString(),
      expired: row.leaseUntil.getTime() <= now.getTime(),
    };
  if (row.waitReason === jobWaitReason.enum.ai_funding_window)
    return {
      reason: "waiting_funding",
      lane,
      until: row.runAt.toISOString(),
    };
  const later = row.runAt.getTime() > now.getTime();
  if (row.waitReason === jobWaitReason.enum.device && later)
    return row.lane === "device"
      ? device
      : { reason: "blocked", lane, by: "An Apple device preparing its input" };
  if (later)
    return {
      reason: "backing_off",
      lane,
      until: row.runAt.toISOString(),
      attempts: row.failures,
      lastError: row.lastError,
      cause:
        row.waitReason === jobWaitReason.enum.rate_limit ||
        row.waitReason === jobWaitReason.enum.provider_capacity
          ? row.waitReason
          : null,
    };
  return row.lane === "device" ? device : { reason: "due", lane };
}
