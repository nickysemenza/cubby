/**
 * Application Error Utilities
 *
 * Centralized error creation for the application.
 * Extracted from trpc.ts to avoid circular dependencies with repo files.
 */

import { type AppErrorReason, AppErrors } from "@cubby/shared";
import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import { annotateActiveSpanError } from "~/server/tracing";

// Expected 4xx errors that shouldn't be logged as failures
const EXPECTED_ERROR_CODES: Set<string> = new Set([
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BAD_REQUEST",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);

/**
 * Create a TRPCError with consistent error handling:
 * - Derives tRPC error code from AppErrorReason
 * - Logs unexpected errors to console (skips expected 4xx responses)
 * - Annotates the active tracing span with error details
 * - Records the original exception if provided
 */
export function createAppError(
  reason: AppErrorReason,
  message: string,
  originalError?: unknown,
): TRPCError {
  const code = AppErrors[reason] as TRPC_ERROR_CODE_KEY;
  const isExpectedError = EXPECTED_ERROR_CODES.has(code);

  // Only log unexpected errors (5xx, etc.) - expected 4xx are normal business responses
  if (!isExpectedError) {
    if (originalError) {
      console.error(`[${reason}] ${message}`, originalError);
    } else {
      console.error(`[${reason}] ${message}`);
    }
  }

  // Annotate the active tracing span (but don't mark expected errors as ERROR
  // status). No-op in the CF backend, which exposes no out-of-band active span.
  annotateActiveSpanError(
    { "error.reason": reason, "error.message": message },
    isExpectedError ? undefined : { message, exception: originalError },
  );

  return new TRPCError({
    code,
    message,
    cause: { reason, originalError },
  });
}

/**
 * True for expected 4xx business errors (NOT_FOUND, UNAUTHORIZED, validation,
 * etc.) — normal responses, not failures. Mirrors the console-logging skip in
 * createAppError. Used to keep these out of Sentry: they have zero user impact
 * and otherwise flood the issue stream (e.g. a stale cached getByID for a
 * deleted entity, or an unauthenticated request to a protected procedure).
 */
export function isExpectedTRPCError(error: TRPCError): boolean {
  return EXPECTED_ERROR_CODES.has(error.code);
}
