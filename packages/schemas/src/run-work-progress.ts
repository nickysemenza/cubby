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
  /** Consecutive progress intervals include time queued between pages. */
  intervals: z
    .array(
      z.object({
        processed: z.number().positive(),
        elapsedMs: z.number().positive(),
      }),
    )
    .max(12)
    .optional(),
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

/** An observed range, not a statistical confidence interval or completion promise. */
export function runWorkEstimate(sample: RunWorkSample) {
  const intervals = sample.intervals ?? [];
  if (intervals.length < 3 || sample.total === null || sample.finished)
    return null;
  const secondsPerItem = intervals.map(
    ({ processed, elapsedMs }) => elapsedMs / processed / 1000,
  );
  const fastest = Math.min(...secondsPerItem);
  const slowest = Math.max(...secondsPerItem);
  const left = Math.max(0, sample.total - sample.processed);
  return {
    lowerSeconds: left * fastest * 0.8,
    upperSeconds: left * slowest * 1.25,
    confidence:
      slowest / fastest > 3 || intervals.length < 6 ? "low" : "moderate",
    samples: intervals.length,
  };
}

/** Round outwards to avoid precision finer than the observed pace supports. */
export function formatRunWorkEstimate(
  estimate: NonNullable<ReturnType<typeof runWorkEstimate>>,
) {
  const unit =
    estimate.upperSeconds < 3600
      ? 60
      : estimate.upperSeconds < 172800
        ? 3600
        : 86400;
  const label = unit === 60 ? "min" : unit === 3600 ? "h" : "days";
  const lower = Math.floor(estimate.lowerSeconds / unit);
  const upper = Math.max(lower + 1, Math.ceil(estimate.upperSeconds / unit));
  return `${lower < 1 ? "under 1" : lower}–${upper} ${label} remaining · ${estimate.confidence} confidence · ${estimate.samples} progress intervals, including queue delays`;
}

/** Present a recorded sample consistently in list cells and live work snapshots. */
export function readRunWorkPhase(
  sample: RunWorkSample,
  status: string,
  now: Date,
  waiting = false,
): RunWorkPhase {
  const paused = status.startsWith("paused") || status === "needs_review";
  const stale = now.getTime() - Date.parse(sample.sampledAt) > 120_000;
  const state =
    status === "failed" || status === "dispatch_failed"
      ? "failed"
      : sample.finished || status === "completed"
        ? sample.failures
          ? "failed"
          : "completed"
        : paused
          ? "paused"
          : waiting ||
              sample.activity === "capacity" ||
              sample.activity === "retry"
            ? "waiting"
            : "running";
  const estimate = runWorkEstimate(sample);
  const etaSeconds =
    estimate &&
    !paused &&
    !stale &&
    !waiting &&
    state === "running" &&
    sample.ratePerSecond !== null &&
    sample.total !== null
      ? Math.max(
          0,
          Math.ceil((sample.total - sample.processed) / sample.ratePerSecond),
        )
      : null;
  return {
    ...sample,
    state,
    etaSeconds,
    estimateState:
      sample.ratePerSecond === null
        ? null
        : paused
          ? "paused"
          : stale ||
              waiting ||
              sample.activity === "capacity" ||
              sample.activity === "retry"
            ? "stale"
            : "current",
  };
}
