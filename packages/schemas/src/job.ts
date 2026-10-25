import { z } from "zod";

export const jobState = z.enum([
  "queued",
  "running",
  "retry_wait",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type JobState = z.infer<typeof jobState>;

export const jobWaitReasons = [
  "provider_capacity",
  "ai_funding_window",
  "device",
  "rate_limit",
] as const;
export const jobWaitReason = z.enum(jobWaitReasons);
export type JobWaitReason = z.infer<typeof jobWaitReason>;

/** Who executes a Job kind; every waiting-on explanation names its lane. */
export const jobLane = z.enum([
  "apple_device",
  "frontier_ai",
  "server",
  "external",
]);
export type JobLane = z.infer<typeof jobLane>;

/**
 * What one live Job waits on, derived from its stored execution facts by
 * `generic/jobs/repo/waiting-on.ts`. Terminal Jobs wait on nothing (null).
 */
export const jobWaitingOn = z.discriminatedUnion("reason", [
  z.object({
    reason: z.literal("due"),
    lane: jobLane,
    /** Due Jobs the drain (or, for Apple work, the device pull) serves first. */
    aheadCount: z.number().int().nonnegative(),
    /** From the lane's measured claims over the last 30 minutes; null without throughput. */
    etaSeconds: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    reason: z.literal("waiting_device"),
    lane: jobLane,
    aheadCount: z.number().int().nonnegative(),
    etaSeconds: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    reason: z.literal("waiting_funding"),
    lane: jobLane,
    until: z.iso.datetime().nullable(),
  }),
  z.object({
    reason: z.literal("leased"),
    lane: jobLane,
    executor: z.string().nullable(),
    /** The leasing device's installation id as its executor assignment records it; null for cloud executors. */
    executorDeviceId: z.string().nullable(),
    /** When the current lease was claimed. */
    leasedAt: z.iso.datetime().nullable(),
    leaseExpiresAt: z.iso.datetime(),
    /** An expired lease is reclaimed by the next claim; the old executor lost it. */
    expired: z.boolean(),
  }),
  z.object({
    reason: z.literal("backing_off"),
    lane: jobLane,
    until: z.iso.datetime(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    /** A stored provider wait (`rate_limit`, `provider_capacity`), when one set the time. */
    cause: jobWaitReason.nullable(),
  }),
  z.object({
    reason: z.literal("blocked"),
    lane: jobLane,
    by: z.string(),
  }),
  z.object({
    reason: z.literal("paused"),
    lane: jobLane,
    by: z.enum(["member", "run"]),
  }),
  z.object({
    reason: z.literal("update_required"),
    lane: jobLane,
    device: z.string(),
  }),
]);
export type JobWaitingOn = z.infer<typeof jobWaitingOn>;
export const jobWaitingOnReason = z.enum([
  "due",
  "waiting_device",
  "waiting_funding",
  "leased",
  "backing_off",
  "blocked",
  "paused",
  "update_required",
] satisfies readonly JobWaitingOn["reason"][]);
export type JobWaitingOnReason = z.infer<typeof jobWaitingOnReason>;

/** Failures after which never-exhausting work also shows as needing attention. */
export const JOB_NEEDS_ATTENTION_ATTEMPTS = 5;

export const jobPayload = z.json();
export type JobPayload = z.infer<typeof jobPayload>;

export const enqueueJobInput = z.object({
  key: z.string().min(1),
  kind: z.string().min(1),
  input: jobPayload,
  runId: z.uuid().nullable().optional(),
  subjectKind: z.string().min(1).nullable().optional(),
  subjectId: z.string().min(1).nullable().optional(),
  priority: z.number().int().optional(),
  maxAttempts: z.number().int().positive().optional(),
  /** Opt-in inactivity budget; useful domain commits, not waits, renew it. */
  recoveryTimeoutMs: z.number().int().positive().optional(),
  availableAt: z.date().optional(),
  /** Explicit new input or member retry; routine recovery never revives failures. */
  invalidate: z.boolean().optional(),
});
export type EnqueueJobInput = z.infer<typeof enqueueJobInput>;

export const jobPage = z.object({
  done: z.boolean(),
  cursor: jobPayload.optional(),
  result: jobPayload.optional(),
  availableAt: z.date().optional(),
  waitReason: jobWaitReason.optional(),
  waitUntil: z.date().optional(),
});
export type JobPage = z.infer<typeof jobPage>;

export const JOB_LANE_LABEL = {
  apple_device: "Apple devices",
  frontier_ai: "Cloud AI",
  server: "Cubby server",
  external: "External services",
} as const satisfies Record<JobLane, string>;

export const JOB_WAITING_ON_LABEL = {
  due: "Due",
  waiting_device: "Waiting for any Apple device",
  waiting_funding: "Waiting for AI funding",
  leased: "In progress",
  backing_off: "Backing off",
  blocked: "Blocked",
  paused: "Paused",
  update_required: "Update required",
} as const satisfies Record<JobWaitingOnReason, string>;

/** A rounded span ("40 s", "12 min", "3 h", "2 d"). */
function jobSpanText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
const untilText = (iso: string, now: Date) => {
  const seconds = (Date.parse(iso) - now.getTime()) / 1000;
  return seconds > 0 ? `for ${jobSpanText(seconds)}` : "until now";
};

/**
 * One line naming what a Job waits on, for every text surface (generated
 * entity fields, Activity, explain). Raw errors stay in their own field.
 */
export function describeJobWaitingOn(
  waitingOn: JobWaitingOn | null,
  now = new Date(),
): string | null {
  if (!waitingOn) return null;
  switch (waitingOn.reason) {
    case "due":
    case "waiting_device": {
      const label =
        waitingOn.reason === "due"
          ? `Due on ${JOB_LANE_LABEL[waitingOn.lane]}`
          : JOB_WAITING_ON_LABEL.waiting_device;
      const ahead = waitingOn.aheadCount
        ? `, behind ${waitingOn.aheadCount}`
        : "";
      const eta =
        waitingOn.etaSeconds !== null
          ? `, about ${jobSpanText(waitingOn.etaSeconds)}`
          : "";
      return `${label}${ahead}${eta}`;
    }
    case "waiting_funding":
      return waitingOn.until
        ? `Waiting for AI funding ${untilText(waitingOn.until, now)}`
        : "Waiting for AI funding";
    case "leased": {
      const who = waitingOn.executor ?? "an executor";
      return waitingOn.expired
        ? `Lease on ${who} expired; waiting to be reclaimed`
        : `In progress on ${who}`;
    }
    case "backing_off":
      return `Backing off ${untilText(waitingOn.until, now)} after ${waitingOn.attempts} ${waitingOn.attempts === 1 ? "failure" : "failures"}`;
    case "blocked":
      return `Blocked by ${waitingOn.by}`;
    case "paused":
      return waitingOn.by === "run" ? "Paused with its Run" : "Paused";
    case "update_required":
      return `${waitingOn.device} needs a Cubby update`;
  }
}

/**
 * A Run rollup's live Jobs as one line ("12 due · 3 in progress"), in the
 * fixed reason order; null when no live Job remains.
 */
export function describeJobRollup(
  counts: Partial<Record<JobWaitingOnReason, number>>,
): string | null {
  const parts = jobWaitingOnReason.options.flatMap((reason) => {
    const count = counts[reason] ?? 0;
    const label = JOB_WAITING_ON_LABEL[reason];
    // Only the leading letter: "Apple" and "AI" keep their case.
    return count
      ? [`${count} ${label.charAt(0).toLowerCase()}${label.slice(1)}`]
      : [];
  });
  return parts.length ? parts.join(" · ") : null;
}
