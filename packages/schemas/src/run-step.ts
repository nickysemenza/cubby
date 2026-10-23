import { z } from "zod";
import { runStepInputMode } from "./activity-fields";
import { runWorkSamples } from "./run-work-progress";

/**
 * One ordered unit of a step-ledger Run (a maintenance backlog, one stage of
 * a Sweep family), declared in `RUN_KINDS`. For a `count` step `found` is the
 * population frozen when the step started; `left` is derived at read as
 * found − done − failed − skipped − removed. `tally` steps have no `found`.
 */
export const runStepState = z.enum([
  "queued",
  "running",
  "waiting",
  "paused",
  "done",
  "failed",
]);
export type RunStepState = z.infer<typeof runStepState>;

export const RUN_STEP_ERROR_SAMPLE = 20;

/** A raw failure as the step saw it; only `scrubErrorMessage` redacts it. */
export const runStepError = z.object({
  at: z.iso.datetime(),
  message: z.string(),
  /** The failed item (`image:<uuid>`, `charge:<source>:<key>`) a retry re-admits. */
  ref: z.string().optional(),
});
export type RunStepError = z.infer<typeof runStepError>;
export const runStepErrors = z.array(runStepError).max(RUN_STEP_ERROR_SAMPLE);

/**
 * Step annotations: the failures a retry re-admits, and a driver's own scalar
 * details (a phase split, a budget note) shown beside the step.
 */
const tallies = z.record(z.string(), z.number().int().nonnegative());

/**
 * The population a step froze when it started: one COUNT per step
 * generation over the predicate its pager walks, bounded by `boundary`
 * (a cutoff the pager also applies). Never recounted on resume or read.
 */
export const runStepInput = z.object({
  mode: runStepInputMode,
  /** The frozen count, or a provider's estimate; null for a tally. */
  total: z.number().int().nonnegative().nullable(),
  boundary: z.json().nullable(),
  countedAt: z.iso.datetime(),
});
export type RunStepInput = z.infer<typeof runStepInput>;

/**
 * What a step's last page spent its time on, written by the step driver
 * through the page context: wall time per phase (`selection`,
 * `preparation`, `publication`, `application`), the database queries it
 * issued (null when the driver's database path cannot count them), and each
 * bounded phase's peak in-flight work. Absent until a driver measures it;
 * readers say "not measured", never estimate.
 */
export const runStepPageSample = z.object({
  /** Entire page wall time; database activity overlaps these phases. */
  wallMs: z.number().nonnegative().optional(),
  database: z
    .object({
      queryTotalMs: z.number().nonnegative(),
      queryActiveWallMs: z.number().nonnegative(),
      queryMaxMs: z.number().nonnegative(),
      poolWaitTotalMs: z.number().nonnegative(),
      poolWaitActiveWallMs: z.number().nonnegative(),
      clientQueueTotalMs: z.number().nonnegative(),
      clientQueueActiveWallMs: z.number().nonnegative(),
    })
    .optional(),
  timings: z.record(z.string(), z.number().nonnegative()),
  queries: z.number().int().nonnegative().nullable(),
  concurrency: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type RunStepPageSample = z.infer<typeof runStepPageSample>;

export const runStepMeta = z.object({
  input: runStepInput.optional(),
  /**
   * Running counts without a denominator: candidates, decisions, and
   * `removed` (inputs that left eligibility after the count froze).
   */
  tallies: tallies.optional(),
  /** Why inputs produced no result, summed per page (`no_candidate: 12`). */
  reasons: tallies.optional(),
  /** What the step is doing now when narrower than its declared action. */
  action: z.string().nullable().optional(),
  capacityUntil: z.iso.datetime().nullable().optional(),
  work: runWorkSamples.optional(),
  /**
   * Every failed item ref (`image:<id>`), uncapped: `errors` keeps only a
   * sample for display, so a retry re-admits from this set.
   */
  failedRefs: z.array(z.string()).optional(),
  /** The failed refs a "Retry failed" handed back to the step's driver. */
  retryRefs: z.array(z.string()).optional(),
  retriedFailures: z.number().int().nonnegative().optional(),
  /** Wall time of the step's pages, so a slow backlog shows where it waits. */
  timing: z
    .object({
      lastPageMs: z.number().nonnegative(),
      totalMs: z.number().nonnegative(),
    })
    .optional(),
  /** The last page's phase timings, query count and peak concurrency. */
  page: runStepPageSample.optional(),
  detail: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
export type RunStepMeta = z.infer<typeof runStepMeta>;

export const runStepCounts = z.object({
  found: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type RunStepCounts = z.infer<typeof runStepCounts>;
