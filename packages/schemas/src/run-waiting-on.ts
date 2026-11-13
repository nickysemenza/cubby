import { z } from "zod";

/** What holds a Run back, in member words. */
const runWaitReason = z.enum([
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
]);
export type RunWaitReason = z.infer<typeof runWaitReason>;

/**
 * What a Run waits on: the dominant reason among its live work, its place in
 * that kind's claim order and when the wait should end. Derived on read from
 * the Run's kernel claims (`readRunRollups`); never stored.
 */
export const runWaitingOn = z.object({
  reason: runWaitReason,
  /** The whole wait in one line, for text surfaces (Apple, MCP, CLI). */
  label: z.string(),
  /** The Pass name `reason` describes; null for a Run-level wait. */
  kind: z.string().nullable(),
  /** The Run's first due Pass among every due Pass of `kind`, in claim order, 1-based. */
  position: z.number().int().positive().nullable(),
  /** Due Passes of `kind`, across every Run. */
  total: z.number().int().positive().nullable(),
  /** Pass pages of `kind` finished per minute over `paceMinutes`; null when none finished. */
  perMinute: z.number().positive().nullable(),
  paceMinutes: z.number().int().positive(),
  /** When the wait should end: position at that pace, the funding resume, or when the claim falls due. */
  etaAt: z.iso.datetime().nullable(),
  /** The most common error class behind a retry. */
  errorClass: z.string().nullable(),
  /** Every live claim by what it waits on ("36 backing off · 1 in progress"). */
  jobs: z.string().nullable(),
});
export type RunWaitingOn = z.infer<typeof runWaitingOn>;
