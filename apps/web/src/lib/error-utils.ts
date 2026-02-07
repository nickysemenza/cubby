import type { AppErrorReason } from "@cubby/shared";
import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "~/server/api/root";

// Re-export from shared for convenience (22+ consumers)
export { getErrorMessage } from "@cubby/shared";

function isTRPCClientError(
  err: unknown,
): err is TRPCClientErrorLike<AppRouter> {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;
  const messageOk = typeof obj.message === "string";
  const dataOk = typeof obj.data === "object" && obj.data !== null;
  return messageOk && dataOk;
}

type AppErrorDetails = {
  message: string;
  code?: string;
  reason?: AppErrorReason;
};

export function getAppErrorDetails(error: unknown): AppErrorDetails {
  if (isTRPCClientError(error)) {
    const code = error.data?.code as string | undefined;
    const reason = (() => {
      const d = error.data as Record<string, unknown> | undefined;
      const r = d?.reason;
      return typeof r === "string" ? (r as AppErrorReason) : undefined;
    })();
    return {
      message: error.message,
      code,
      reason,
    };
  }
  return {
    message: typeof error === "string" ? error : "An error occurred",
  };
}

/**
 * Returns true if an error is not worth retrying (logical/4xx or known reasons).
 */
function isNonRetriableError(details: AppErrorDetails): boolean {
  const c = details.code;
  if (!c) return false;
  return (
    c === "UNAUTHORIZED" ||
    c === "FORBIDDEN" ||
    c === "PRECONDITION_FAILED" ||
    c === "BAD_REQUEST" ||
    c === "CONFLICT" ||
    c === "NOT_FOUND"
  );
}

/**
 * Helper used by React Query `retry` fn.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  const details = getAppErrorDetails(error);
  if (isNonRetriableError(details)) return false;
  return failureCount < 3;
}
