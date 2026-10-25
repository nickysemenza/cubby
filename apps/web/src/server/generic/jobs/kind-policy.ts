import type { JobLane } from "@cubby/schemas/job";

/**
 * How a failed page waits before its next claim. `exhaust: true` fails the Job
 * after its row's `maxAttempts` consecutive failures; `exhaust: false` keeps
 * retrying forever with capped exponential backoff, and neither claims nor
 * lease expiry count as attempts — only reported failures do.
 */
export type JobRetryPolicy =
  | { readonly exhaust: true }
  | {
      readonly exhaust: false;
      readonly baseMs: number;
      readonly maxMs: number;
    };

export type JobKindPolicy = {
  readonly internal: boolean;
  readonly lane: JobLane;
  /** False: only an external executor's pull claims it; the server drain never does. */
  readonly drained: boolean;
  readonly retry: JobRetryPolicy;
  /** Queued Jobs a kind should keep at most; the watchdog alerts above it. */
  readonly maxQueued: number | null;
};

const IMAGE_RETRY = {
  exhaust: false,
  baseMs: 30_000,
  maxMs: 24 * 60 * 60_000,
} as const satisfies JobRetryPolicy;

const MAINTENANCE_RETRY = {
  exhaust: false,
  baseMs: 60_000,
  maxMs: 15 * 60_000,
} as const satisfies JobRetryPolicy;

const SERVER: JobKindPolicy = {
  internal: false,
  lane: "server",
  drained: true,
  retry: { exhaust: true },
  maxQueued: null,
};

/**
 * The one registry of per-kind execution policy. A kind absent here runs on
 * the server drain and fails after its attempt budget.
 */
export const JOB_KIND_POLICY = {
  // Image processing is never abandoned (docs/jobs.md#image-processing).
  "image.cloud": {
    internal: false,
    lane: "frontier_ai",
    drained: true,
    retry: IMAGE_RETRY,
    maxQueued: null,
  },
  // Parked for Apple devices: their pull claims it; enqueue and connect ring them.
  "image.device": {
    internal: false,
    lane: "apple_device",
    drained: false,
    retry: IMAGE_RETRY,
    maxQueued: null,
  },
  // Self-arming maintenance pages must never stop on a transient failure.
  "queue.watchdog": { ...SERVER, internal: true, retry: MAINTENANCE_RETRY },
  // Rings companions when parked device work comes due (docs/jobs.md#image-processing).
  "image.device.wake": { ...SERVER, internal: true, retry: MAINTENANCE_RETRY },
  "jobs.retention": { ...SERVER, internal: true, retry: MAINTENANCE_RETRY },
  "ai-refresh.activate": { ...SERVER, internal: true },
  // The derived drain and reconcile never fail: a failing page backs off (ADR 0021).
  "derived.drain": { ...SERVER, internal: true, retry: MAINTENANCE_RETRY },
  "derived.reconcile": { ...SERVER, internal: true, retry: MAINTENANCE_RETRY },
  "ai.evaluation": { ...SERVER, lane: "frontier_ai", maxQueued: 2_000 },
  "assessment.correction": { ...SERVER, maxQueued: 500 },
  "purchase.dispatch": { ...SERVER, lane: "external" },
} as const satisfies Record<string, JobKindPolicy>;

const POLICY_BY_KIND: ReadonlyMap<string, JobKindPolicy> = new Map(
  Object.entries(JOB_KIND_POLICY),
);

export const jobKindPolicy = (kind: string): JobKindPolicy =>
  POLICY_BY_KIND.get(kind) ?? SERVER;

/** Hidden from ordinary execution lists, but still counted by queue health. */
export const INTERNAL_JOB_KINDS = Object.entries(JOB_KIND_POLICY)
  .filter(([, policy]) => policy.internal)
  .map(([kind]) => kind);

/** Kinds the server drain must never claim. */
export const UNDRAINED_JOB_KINDS: readonly string[] = Object.entries(
  JOB_KIND_POLICY,
)
  .filter(([, policy]) => !policy.drained)
  .map(([kind]) => kind);

/** Kinds whose failures never end the Job. */
export const NEVER_EXHAUSTED_JOB_KINDS: readonly string[] = Object.entries(
  JOB_KIND_POLICY,
)
  .filter(([, policy]) => !policy.retry.exhaust)
  .map(([kind]) => kind);

/** The wait after `failures` consecutive reported failures of a never-exhausted kind. */
export const neverExhaustedRetryDelayMs = (
  retry: Extract<JobRetryPolicy, { exhaust: false }>,
  failures: number,
) => Math.min(retry.maxMs, retry.baseMs * 2 ** Math.max(0, failures - 1));
