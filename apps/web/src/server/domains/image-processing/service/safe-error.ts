import { z } from "zod";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import { SERVER_FAILURE_RETRYABLE } from "~/server/domains/image-processing/repo/image-processing";
/** Provider/storage errors can contain signed request URLs; never persist them. */
export function safeImageProcessingError(error: unknown): string {
  const parsed = z.instanceof(Error).safeParse(error);
  const message = parsed.success
    ? parsed.data.message
    : "Image processing failed";
  return (
    message
      .replace(/https?:\/\/[^\s<>"']+/gi, "[URL omitted]")
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(
        /((?:api[_-]?key|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      )
      .slice(0, 1000) || "Image processing failed"
  );
}

/** Statuses a later attempt can outlast: timeout, conflict, too early, rate limit. */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 409, 425, 429]);

/**
 * A provider refusal of the request itself (a retired or unknown route, a
 * rejected image) repeats on every attempt; settle it failed with its raw
 * diagnostic. Network, 5xx and rate-limit failures keep the bounded backoff.
 */
export function cloudFailureRetryable(error: UnparsedError): boolean {
  const hard = describeErrorCauses(error).causes.some(
    ({ status }) =>
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      !TRANSIENT_CLIENT_STATUSES.has(status),
  );
  return hard ? false : SERVER_FAILURE_RETRYABLE;
}
