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
  if (cooperative.getStore()) throw new AiWorkDeferredError(until);
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
