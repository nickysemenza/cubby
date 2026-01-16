/**
 * Application Error Utilities
 *
 * Centralized error creation for the application.
 * Extracted from trpc.ts to avoid circular dependencies with repo files.
 */

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { TRPCError } from "@trpc/server";
import { type AppErrorReason, AppErrors } from "~/lib/app-error-codes";

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
  const code = AppErrors[reason];
  const isExpectedError = EXPECTED_ERROR_CODES.has(code);

  // Only log unexpected errors (5xx, etc.) - expected 4xx are normal business responses
  if (!isExpectedError) {
    if (originalError) {
      console.error(`[${reason}] ${message}`, originalError);
    } else {
      console.error(`[${reason}] ${message}`);
    }
  }

  // Annotate tracing span (but don't mark expected errors as ERROR status)
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes({
      "error.reason": reason,
      "error.message": message,
    });
    if (!isExpectedError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (originalError instanceof Error || typeof originalError === "string") {
        span.recordException(originalError);
      }
    }
  }

  return new TRPCError({
    code,
    message,
    cause: { reason, originalError },
  });
}
