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
