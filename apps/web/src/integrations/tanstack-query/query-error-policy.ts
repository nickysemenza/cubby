import { getAppErrorDetails } from "~/lib/error-utils";

interface FailedQuery {
  meta: Record<string, unknown> | undefined;
  getObserversCount: () => number;
}

export function shouldToastQueryError(
  error: unknown,
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
  return !(
    query.meta?.speculativePreview === true && query.getObserversCount() === 0
  );
}
