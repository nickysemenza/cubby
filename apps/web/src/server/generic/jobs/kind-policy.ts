import type { JobLane } from "@cubby/schemas/job";

/** A failed page waits `baseMs · 2^(failures - 1)`, capped at `maxMs`. */
export type JobBackoff = { readonly baseMs: number; readonly maxMs: number };

export type JobKindPolicy = {
  readonly internal: boolean;
  readonly lane: JobLane;
  /** False: only an external executor's pull claims it; the server drain never does. */
  readonly drained: boolean;
  /**
   * Consecutive reported failures before the Job fails. Null never exhausts:
   * subject-owned work and drains back off forever. Reclaiming an expired
   * lease counts as a failure, so a crash loop still exhausts.
   */
  readonly maxAttempts: number | null;
  readonly backoff: JobBackoff;
  /** Live leases of this kind across every drain; Run-owned work is exempt. */
  readonly maxInFlight?: number;
};

const IMAGE_BACKOFF = { baseMs: 30_000, maxMs: 24 * 60 * 60_000 };
const MAINTENANCE_BACKOFF = { baseMs: 60_000, maxMs: 15 * 60_000 };

const SERVER: JobKindPolicy = {
  internal: false,
  lane: "server",
  drained: true,
  maxAttempts: 3,
  backoff: { baseMs: 1_000, maxMs: 60_000 },
};
/** Self-arming pages and drains: a failure backs off, never stops the Job. */
const MAINTENANCE: JobKindPolicy = {
  ...SERVER,
  internal: true,
  maxAttempts: null,
  backoff: MAINTENANCE_BACKOFF,
};
/** A drain Job owns no work of its own; its items retry on their own rows. */
const DRAIN: JobKindPolicy = { ...MAINTENANCE, internal: false };

/**
 * The one registry of per-kind execution policy. A kind absent here runs on
 * the server drain and fails after three consecutive failures.
 */
export const JOB_KIND_POLICY = {
  // Image processing is never abandoned (docs/jobs.md#image-processing).
  "image.cloud": {
    ...SERVER,
    lane: "frontier_ai",
    maxAttempts: null,
    backoff: IMAGE_BACKOFF,
  },
  // Parked for Apple devices: their pull claims it; enqueue and connect ring them.
  "image.device": {
    ...SERVER,
    lane: "apple_device",
    drained: false,
    maxAttempts: null,
    backoff: IMAGE_BACKOFF,
  },
  // Rings companions when parked device work comes due (docs/jobs.md#image-processing).
  "image.device.wake": MAINTENANCE,
  "jobs.maintenance": MAINTENANCE,
  "ai-refresh.activate": { ...SERVER, internal: true },
  "derived.drain": MAINTENANCE,
  "derived.reconcile": MAINTENANCE,
  // One drain per feature; two pages at once leave the other lanes free.
  "ai.evaluation": { ...DRAIN, lane: "frontier_ai", maxInFlight: 2 },
  "embedding.refresh": DRAIN,
  "embedding.cleanup": DRAIN,
  "purchase.dispatch": { ...SERVER, lane: "external" },
} as const satisfies Record<string, JobKindPolicy>;

const POLICY_BY_KIND: ReadonlyMap<string, JobKindPolicy> = new Map(
  Object.entries(JOB_KIND_POLICY),
);

export const jobKindPolicy = (kind: string): JobKindPolicy =>
  POLICY_BY_KIND.get(kind) ?? SERVER;

/** Hidden from ordinary execution lists. */
export const INTERNAL_JOB_KINDS = Object.entries(JOB_KIND_POLICY)
  .filter(([, policy]) => policy.internal)
  .map(([kind]) => kind);

/** Kinds the server drain must never claim. */
export const UNDRAINED_JOB_KINDS: readonly string[] = Object.entries(
  JOB_KIND_POLICY,
)
  .filter(([, policy]) => !policy.drained)
  .map(([kind]) => kind);

/** The wait after `failures` consecutive reported failures. */
export const jobRetryDelayMs = (backoff: JobBackoff, failures: number) =>
  Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, failures - 1));
