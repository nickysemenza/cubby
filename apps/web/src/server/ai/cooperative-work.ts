import { AsyncLocalStorage } from "node:async_hooks";

import type { UnparsedError } from "~/lib/error-utils";

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
  // Durable retries need time to release shared capacity without exhausting page bounds.
  if (cooperative.getStore())
    throw new AiWorkDeferredError(Math.max(until, Date.now() + 15_000));
}

export function aiWorkDeferral(
  error: UnparsedError,
): AiWorkDeferredError | null {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AiWorkDeferredError) return error;
    seen.add(error);
    error = error.cause;
  }
  return null;
}
