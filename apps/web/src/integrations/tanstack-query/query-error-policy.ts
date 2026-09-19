import type { Query } from "@tanstack/react-query";

import { getAppErrorDetails } from "~/lib/error-utils";
import type { UnparsedError } from "~/lib/error-utils";

interface FailedQuery {
  meta: Query["meta"];
  getObserversCount: () => number;
}

interface FailedMutation {
  options: { onError?: unknown };
}

export function shouldToastQueryError(
  error: UnparsedError,
  query: FailedQuery,
): boolean {
  const code = getAppErrorDetails(error).code;
  if (
    code === "NOT_FOUND" ||
    code === "UNAUTHORIZED" ||
    code === "BAD_REQUEST"
  ) {
    return false;
  }
  // Suggestion queries (`ai.suggestFields`) are advisory: a hint the field
  // never asked for, not a value the user requested. An unconfigured AI
  // gateway would otherwise toast on every dialog a suggestable field appears
  // in.
  if (query.meta?.silentErrors === true) return false;
  return !(query.meta?.speculative === true && query.getObserversCount() === 0);
}

/**
 * A mutation-level error callback owns rollback and user presentation. Per-call
 * `mutate(..., { onError })` callbacks are not present on `mutation.options`, so
 * user-facing handlers belong on the descriptor/options passed to useMutation.
 */
export function shouldToastMutationError(mutation: FailedMutation): boolean {
  return mutation.options.onError === undefined;
}
