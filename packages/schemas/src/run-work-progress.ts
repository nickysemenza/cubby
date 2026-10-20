import { z } from "zod";

export const runWorkItems = z.object({
  phase: z.string(),
  label: z.string(),
  unit: z.string(),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  failures: z.number().int().nonnegative(),
  activity: z
    .enum(["computing", "publishing", "capacity", "retry", "handoff"])
    .optional(),
});
export type RunWorkItems = z.infer<typeof runWorkItems>;

export const runWorkSample = runWorkItems.extend({
  sampledAt: z.iso.datetime(),
  ratePerSecond: z.number().finite().positive().nullable(),
  finished: z.boolean(),
});
export type RunWorkSample = z.infer<typeof runWorkSample>;

export const runWorkSamples = z.object({
  current: runWorkSample,
  completed: z.array(runWorkSample),
});
export type RunWorkSamples = z.infer<typeof runWorkSamples>;

export const runWorkPhase = runWorkSample.extend({
  state: z.enum(["running", "waiting", "paused", "completed", "failed"]),
  etaSeconds: z.number().int().nonnegative().nullable(),
  estimateState: z.enum(["current", "paused", "stale"]).nullable(),
});
export type RunWorkPhase = z.infer<typeof runWorkPhase>;
export const runWorkProgress = z.object({
  current: runWorkPhase,
  completed: z.array(runWorkPhase),
});
export type RunWorkProgress = z.infer<typeof runWorkProgress>;
