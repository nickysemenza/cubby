import type { ExecutionWaitReason } from "@cubby/schemas/execution";

/** Fresh evidence or eligibility is required; retire the stale target without spending attempts. */
export class WorkEvidenceObsoleteError extends Error {}

/** Pure control signals shared with providers without importing the database runtime. */
export class WorkPausedError extends Error {}
/** A page may retry this target alone after rolling back its shared publication. */
export class WorkTargetError extends Error {}
/** Retryable external failure governed by the claim's transient backoff. */
export class WorkRetryableError extends Error {}
export class WorkDeferredError extends Error {
  constructor(
    message: string,
    readonly until: Date,
    readonly reason: ExecutionWaitReason,
  ) {
    super(message);
  }
}
export class WorkSupersededError extends Error {
  constructor() {
    super("Work claim is obsolete");
  }
}
