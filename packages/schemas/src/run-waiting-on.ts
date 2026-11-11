import { z } from "zod";

/** What holds a Run back, in member words; `unfinished` is a Run with no work left that never ended. */
export const runWaitReason = z.enum([
  "funding",
  "model_capacity",
  "rate_limit",
  "retry",
  "device",
  "queued",
  "in_progress",
  "reclaim",
  "blocked",
  "paused",
  "unfinished",
]);
export type RunWaitReason = z.infer<typeof runWaitReason>;

/**
 * What a Run waits on: the dominant reason among its live work, its place in
 * that kind's claim order and when the wait should end. Derived on read from
 * the Run's Jobs and the queue (`readRunRollups`); never stored.
 */
export const runWaitingOn = z.object({
  reason: runWaitReason,
  /** The whole wait in one line, for text surfaces (Apple, MCP, CLI). */
  label: z.string(),
  /** The Job kind `reason` describes; null for a Run-level wait. */
  kind: z.string().nullable(),
  /** The Run's first Job among waiting Jobs of `kind` with the same wait, in claim order, 1-based. */
  position: z.number().int().positive().nullable(),
  /** Waiting Jobs of `kind` with the same wait, across every Run. */
  total: z.number().int().positive().nullable(),
  /** Jobs of `kind` finished per minute over `paceMinutes`; null when none finished. */
  perMinute: z.number().positive().nullable(),
  paceMinutes: z.number().int().positive(),
  /** When the wait should end: position at that pace, the funding resume, or the next retry. */
  etaAt: z.iso.datetime().nullable(),
  /** The most common error class behind a retry. */
  errorClass: z.string().nullable(),
  /** Every live Job by what it waits on ("36 backing off · 1 in progress"). */
  jobs: z.string().nullable(),
});
export type RunWaitingOn = z.infer<typeof runWaitingOn>;
