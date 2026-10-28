import { JOB_KIND_POLICY, type JobBackoff } from "@cubby/schemas/job";
export {
  JOB_KIND_POLICY,
  jobKindPolicy,
  type JobBackoff,
} from "@cubby/schemas/job";

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
