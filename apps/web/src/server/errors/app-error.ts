/**
 * Application Error Utilities
 *
 * Centralized error creation for the application.
 * Extracted from trpc.ts to avoid circular dependencies with repo files.
 */

import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";
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
 * A refusal that can name what blocked it.
 *
 * `createAppError` carries only `{reason, originalError}`, so a guard that knew
 * exactly which rows blocked — and how many dependents each had — could only
 * render that into a sentence and drop the structure. The preview path has
 * expressed the same facts as `ImpactItem`s for a while; this is the mutation
 * path finally being able to say the same thing in the same vocabulary.
 *
 * A separate function rather than a fourth parameter on `createAppError`: a
 * blocked refusal always has blockers, and threading an optional past
 * `originalError` at 229 existing call sites would make the common case read
 * worse to serve the rare one.
 *
 * `blockers` must be PUBLIC items — `toPublicImpact` output, keyed by shortcode.
 * The branded type is what enforces that; a uuid-keyed `InternalImpactItem`
 * will not compile here, which is the whole point of the two brands.
 */
export function createBlockedError(
  reason: AppErrorReason,
  message: string,
  blockers: readonly PublicImpactItem[],
): TRPCError {
  const error = createAppError(reason, message);
  // Rebuilt rather than mutated: `cause` is readonly on TRPCError, and
  // reconstructing keeps `createAppError` the single place that derives the
  // code, logs, and annotates the span.
  return new TRPCError({
    code: error.code,
    message,
    cause: { reason, blockers },
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
