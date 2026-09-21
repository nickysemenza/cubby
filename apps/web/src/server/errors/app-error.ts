import {
  type PublicImpactItem,
  publicImpactItemSchema,
} from "@cubby/schemas/entity-integrity";
import { type AppErrorReason, AppErrors } from "@cubby/shared";
import { z } from "zod";

import { annotateActiveSpanError } from "~/server/tracing";

export type AppErrorCode = (typeof AppErrors)[AppErrorReason];

/** Transport-neutral domain failure. Adapters decide its wire representation. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly reason: AppErrorReason;
  readonly blockers?: readonly PublicImpactItem[];

  constructor(options: {
    code: AppErrorCode;
    reason: AppErrorReason;
    message: string;
    cause?: unknown;
    blockers?: readonly PublicImpactItem[];
  }) {
    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.reason = options.reason;
    this.blockers = options.blockers;
  }
}

// Expected 4xx errors that shouldn't be logged as failures
const EXPECTED_ERROR_CODES: Set<string> = new Set([
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BAD_REQUEST",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);

const unparsedErrorSchema = z.unknown();
const publicErrorCarrierSchema = z.object({
  code: z.string().optional().catch(undefined),
  cause: z
    .object({
      reason: z.string().optional().catch(undefined),
      blockers: z.array(publicImpactItemSchema).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

type UnparsedError = z.input<typeof unparsedErrorSchema>;

/**
 * Create an application error with consistent diagnostics:
 * - Derives its transport-neutral code from AppErrorReason
 * - Logs unexpected errors to console (skips expected 4xx responses)
 * - Annotates the active tracing span with error details
 * - Records the original exception if provided
 */
export function createAppError(
  reason: AppErrorReason,
  message: string,
  originalError?: UnparsedError,
): AppError {
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

  // Annotate the active tracing span (but don't mark expected errors as ERROR
  // status). No-op in the CF backend, which exposes no out-of-band active span.
  annotateActiveSpanError(
    { "error.reason": reason, "error.message": message },
    isExpectedError ? undefined : { message, exception: originalError },
  );

  return new AppError({
    code,
    reason,
    message,
    cause: originalError,
  });
}

/**
 * A refusal that can name what blocked it.
 *
 * Retains the same structured impact items used by operation previews.
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
): AppError {
  const error = createAppError(reason, message);
  return new AppError({
    code: error.code,
    reason,
    message,
    blockers,
    cause: error.cause,
  });
}

/**
 * Everything a client may learn about a thrown error — the ONE whitelist.
 *
 * `cause` never crosses either boundary: it is `unknown`, it can hold an
 * arbitrary original exception, and both transports have to lift what they
 * expose out of it explicitly. That lifting used to be written twice — once in
 * the browser adapter and once in the MCP layer's `describeToolError` — and
 * the two promptly disagreed: the MCP copy read `code` and `reason` and never
 * `blockers`, so `delete_entity`'s own description promised blocker ids that
 * the transport silently discarded. Two whitelists that can drift IS the bug,
 * so there is one now and both layers call it.
 *
 * `reason` is deliberately NOT narrowed to `AppErrorReason`. The MCP copy used
 * to narrow, which dropped `INVALID_INPUT` — minted at the MCP boundary itself
 * for a wrong-prefix shortcode, absent from `AppErrors`, and the single most
 * common fault a caller can actually fix. The browser copy never narrowed. Passing
 * the string through is what both sides already needed.
 *
 * `blockers` is parsed rather than passed through: a malformed payload must not
 * become the client's problem, and the branded `publicImpactItemSchema` is what
 * makes "keyed by shortcode, never uuid" a checked property at the boundary.
 */
export interface PublicErrorPayload {
  code?: string;
  /** The `AppErrorReason` (or boundary slug) stamped onto `cause`. */
  reason?: string;
  /** Present only for a refusal built by {@link createBlockedError}. */
  blockers?: PublicImpactItem[];
}

export function toPublicErrorPayload(error: UnparsedError): PublicErrorPayload {
  const payload: PublicErrorPayload = {};
  const appError = appErrorFromUnknown(error);
  if (appError) {
    payload.code = appError.code;
    payload.reason = appError.reason;
    if (appError.blockers) payload.blockers = [...appError.blockers];
    return payload;
  }

  const parsed = readPublicErrorCarrier(error);
  if (!parsed.success) return payload;
  if (parsed.data.code) payload.code = parsed.data.code;
  if (parsed.data.cause?.reason) payload.reason = parsed.data.cause.reason;
  if (parsed.data.cause?.blockers) {
    payload.blockers = parsed.data.cause.blockers;
  }
  return payload;
}

function readPublicErrorCarrier(error: UnparsedError) {
  try {
    return publicErrorCarrierSchema.safeParse(error);
  } catch {
    return publicErrorCarrierSchema.safeParse(null);
  }
}

/**
 * True when an error is a guard REFUSING an operation, rather than the
 * operation failing.
 *
 * The distinction decides how an MCP tool answers: a refusal is a domain
 * answer that belongs inside the tool's declared output schema, while a fault
 * (unresolvable shortcode, missing row, an actual bug) stays an `isError`
 * envelope. Two signals, because the codebase has two vintages of guard:
 * `createBlockedError` attributes the refusal to specific rows, and the older
 * `createAppError` guards say the same thing with a `PRECONDITION_FAILED` code
 * and prose — which is exactly what every one of the 17 blocking dispositions
 * in `operation-preview-parity.integration.test.ts` asserts on the mutation
 * side, so it is the reliable marker and not a guess.
 *
 * A merge refusal is `BAD_REQUEST` and so is NOT recognized here; it does not
 * need to be, because `merge_entity` already reports every cluster failure
 * inside its own result rather than erroring the envelope.
 */
export function isBlockedRefusal(error: UnparsedError): boolean {
  const payload = toPublicErrorPayload(error);
  return (
    payload.code === "PRECONDITION_FAILED" ||
    (payload.blockers?.length ?? 0) > 0
  );
}

/**
 * True for expected 4xx business errors (NOT_FOUND, UNAUTHORIZED, validation,
 * etc.) — normal responses, not failures. Mirrors the console-logging skip in
 * createAppError. Used to keep these out of Sentry: they have zero user impact
 * and otherwise flood the issue stream (e.g. a stale cached getByID for a
 * deleted entity, or an unauthenticated request to a protected procedure).
 */
export function isExpectedAppError(error: UnparsedError): boolean {
  const code = toPublicErrorPayload(error).code;
  return code !== undefined && EXPECTED_ERROR_CODES.has(code);
}

export function appErrorFromUnknown(error: UnparsedError): AppError | null {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 24) {
    const current = pending.shift();
    if (current instanceof AppError) return current;
    if (seen.has(current)) continue;
    seen.add(current);
    try {
      const carrier = z
        .object({
          cause: z.unknown().optional(),
          originalError: z.unknown().optional(),
        })
        .safeParse(current);
      if (!carrier.success) continue;
      if (carrier.data.cause !== undefined) pending.push(carrier.data.cause);
      if (carrier.data.originalError !== undefined)
        pending.push(carrier.data.originalError);
    } catch {
      // Inspecting an arbitrary thrown value can itself throw.
    }
  }
  return null;
}
