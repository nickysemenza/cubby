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
