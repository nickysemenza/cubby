import type { JobWaitReason } from "@cubby/schemas/job";

/** Pure control signals shared with providers without importing the database runtime. */
export class JobPausedError extends Error {}
/** A page may retry this target alone after rolling back its shared publication. */
export class JobTargetError extends Error {}
/** Transient external failure: retain the existing Job backoff without exhausting it. */
export class JobRetryableError extends Error {}
export class JobDeferredError extends Error {
  constructor(
    message: string,
    readonly until: Date,
    readonly reason: JobWaitReason,
  ) {
    super(message);
  }
}
export class JobSupersededError extends Error {
  constructor() {
    super("Job generation or lease is obsolete");
  }
}
