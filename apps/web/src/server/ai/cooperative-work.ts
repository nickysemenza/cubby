import { AsyncLocalStorage } from "node:async_hooks";

import type { UnparsedError } from "~/lib/error-utils";
import { JobDeferredError } from "~/server/generic/jobs/errors";

const cooperative = new AsyncLocalStorage<boolean>();

/** Workflow pages checkpoint before a durable sleep instead of polling bindings. */
export const withCooperativeAiWork = <T>(work: () => Promise<T>) =>
  cooperative.run(true, work);

export class AiWorkDeferredError extends Error {
  constructor(readonly until: number) {
    super("AI work is waiting for shared capacity");
  }
}

export function deferCooperativeAiWork(until: number) {
  // Admission already supplies a retry deadline; do not stretch a short wait into idle time.
  if (cooperative.getStore())
    throw new AiWorkDeferredError(Math.max(until, Date.now() + 1_000));
}

export function aiWorkDeferral(
  error: UnparsedError,
): AiWorkDeferredError | null {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AiWorkDeferredError) return error;
    // Cache contention uses the Job control signal; item isolation must retain the wait.
    if (error instanceof JobDeferredError) {
      const deferred = new AiWorkDeferredError(error.until.getTime());
      deferred.cause = error;
      return deferred;
    }
    seen.add(error);
    error = error.cause;
  }
  return null;
}
