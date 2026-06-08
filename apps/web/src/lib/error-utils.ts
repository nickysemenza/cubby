// Re-export from shared for convenience (22+ consumers)

export type { AppErrorDetails } from "@cubby/api-contract";

// tRPC error helpers now live in the type-only contract package (so mobile can
// reuse them). Re-exported here to keep the ~22 existing `~/lib/error-utils`
// consumers untouched.
export { getAppErrorDetails, isTRPCClientError } from "@cubby/api-contract";
export { getErrorMessage } from "@cubby/shared";
