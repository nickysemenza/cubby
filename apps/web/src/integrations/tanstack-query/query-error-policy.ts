import type { Query } from "@tanstack/react-query";

import { getAppErrorDetails } from "~/lib/error-utils";
import type { UnparsedError } from "~/lib/error-utils";

interface FailedQuery {
  meta: Query["meta"];
  getObserversCount: () => number;
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
  return !(query.meta?.speculative === true && query.getObserversCount() === 0);
}
