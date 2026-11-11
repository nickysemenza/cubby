import {
  imageJobDisplayState,
  imageProcessingJobState,
  type ImageProcessingJobState,
} from "@cubby/schemas/image-processing";
import {
  JOB_NEEDS_ATTENTION_ATTEMPTS,
  jobWaitReason,
  type JobWaitingOn,
} from "@cubby/schemas/job";
import { and, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { appleFailureCoveredByCloudDescriptionSql } from "~/server/domains/image-processing/repo/processor-policy";
import {
  classifyWaiting,
  classifyWaitingSql,
} from "~/server/generic/jobs/repo/waiting-classifier";

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
  return classifyWaitingSql({
    leased: sql`${c("leaseUntil")} IS NOT NULL`,
    waitReason: c("waitReason"),
    later: sql`${c("runAt")} > ${at(now)}`,
    deviceLane: sql`${c("lane")} = ${"device"}`,
  });
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
  const reason = classifyWaiting({
    leased: row.leaseUntil !== null,
    waitReason: row.waitReason,
    later: row.runAt.getTime() > now.getTime(),
    deviceLane: row.lane === "device",
  });
  switch (reason) {
    case "leased": {
      const leaseUntil = row.leaseUntil ?? now;
      return {
        reason: "leased",
        lane,
        executor:
          executor?.name ?? (row.lane === "cloud" ? "Cubby server" : null),
        executorDeviceId: executor?.deviceId ?? null,
        leasedAt: null,
        leaseExpiresAt: leaseUntil.toISOString(),
        expired: leaseUntil.getTime() <= now.getTime(),
      };
    }
    case "waiting_funding":
      return { reason, lane, until: row.runAt.toISOString() };
    case "waiting_device":
      return device;
    case "blocked":
      return { reason, lane, by: "An Apple device preparing its input" };
    case "backing_off":
      return {
        reason,
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
    default:
      return { reason: "due", lane };
  }
}

/** Read-only actionability; the stored job and every attempt retain their outcome. */
export function imageJobActionStateSql(
  alias = "ImageProcessingJob",
): SQL<ImageProcessingJobState | "cloud_satisfied"> {
  const covered = sql<boolean>`EXISTS (SELECT 1 FROM "Image" satisfaction_source
    WHERE satisfaction_source.id = ${column(alias, "imageId")}
      AND ${notDeleted("satisfaction_source")}
      AND ${appleFailureCoveredByCloudDescriptionSql({ jobAlias: alias, imageId: sql`satisfaction_source.id`, sourceContentHash: sql`satisfaction_source.sha256` })})`;
  return sql`CASE WHEN ${covered} THEN ${imageJobDisplayState.enum.cloud_satisfied} ELSE ${imageJobDisplayStateSql(alias)} END`;
}
