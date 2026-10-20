import { z } from "zod";
import { WORKFLOW_EXECUTION_LIMITS } from "@cubby/shared/workflow-limits";
import { runWorkSamples } from "./run-work-progress";

/**
 * One ordered unit of a step-ledger Run (a maintenance backlog, a Sweep's
 * Suggestion family). Counts are atomic increments; `left` is derived at read
 * as found − done − failed − skipped, and a step with a child Run reports the
 * child's counts, never a copy of them.
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
export const MAX_STEP_RUN_INSTANCE_PAGES =
  WORKFLOW_EXECUTION_LIMITS.maxPagesPerInstance;

/** A driver declares its phase budget; the Workflow owns the instance boundary. */
export const runStepExecution = z.object({
  phase: z.string(),
  pagesPerInstance: z
    .number()
    .int()
    .positive()
    .max(MAX_STEP_RUN_INSTANCE_PAGES),
});
export type RunStepExecution = z.infer<typeof runStepExecution>;

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
export const runStepMeta = z.object({
  capacityUntil: z.iso.datetime().nullable().optional(),
  batchRetry: z
    .object({
      attempt: z.number().int().positive(),
      dueAt: z.iso.datetime(),
      skippedIds: z.array(z.string()).optional(),
      delta: z.object({
        done: z.number().int().nonnegative().optional(),
        skipped: z.number().int().nonnegative().optional(),
      }),
    })
    .nullable()
    .optional(),
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
