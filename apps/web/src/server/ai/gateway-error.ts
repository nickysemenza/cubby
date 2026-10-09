import type {
  GatewayResponseFailure,
  GatewayResponseWire,
} from "@cubby/shared/ai/gateway-request";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";

class GatewayHttpError extends Error {
  readonly status: number;
  /** The raw `Retry-After` header: delay seconds or an HTTP date. */
  readonly retryAfter: string | null;

  constructor(failure: GatewayResponseFailure, cause: unknown) {
    const retry = failure.retryAfter
      ? ` (Retry-After: ${failure.retryAfter})`
      : "";
    super(
      `HTTP ${failure.status} ${failure.statusText}${retry}: ${failure.body}`,
      {
        cause,
      },
    );
    this.name = "GatewayHttpError";
    this.status = failure.status;
    this.retryAfter = failure.retryAfter;
  }
}

/** Keep request identity next to the provider's original error and stack. */
class AiGatewayRequestError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AiGatewayRequestError";
  }
}

export function wrapAiGatewayError(
  error: UnparsedError,
  context: {
    model: string;
    provider: string;
    route: string;
    feature: string;
    operation: string;
    gatewayLogId?: string | null;
    recoveredFailures?: readonly GatewayResponseFailure[];
    responseWire?: GatewayResponseWire;
  },
  responseFailure?: GatewayResponseFailure,
): Error {
  const log = context.gatewayLogId
    ? `, gateway log: ${context.gatewayLogId}`
    : "";
  const cause = responseFailure
    ? new GatewayHttpError(responseFailure, error)
    : error;
  const reason = cause instanceof Error ? cause.message : String(cause);
  const recovered = context.recoveredFailures?.length
    ? `; recovered refusals: ${context.recoveredFailures.map((failure) => `${failure.status} ${failure.statusText}: ${failure.body}`).join("; ")}`
    : "";
  const wire =
    context.responseWire && !responseFailure
      ? `; response wire: ${JSON.stringify({
          status: context.responseWire.status,
          contentType: context.responseWire.contentType?.slice(0, 128) ?? null,
          requestId: context.responseWire.requestId?.slice(0, 128) ?? null,
        })}`
      : "";
  return new AiGatewayRequestError(
    `AI Gateway request failed (model: ${context.model}, provider: ${context.provider}, route: ${context.route}, feature: ${context.feature}, operation: ${context.operation}${log}): ${reason}${recovered}${wire}`,
    cause,
  );
}

export function isAiGatewayRateLimit(error: UnparsedError): boolean {
  return describeErrorCauses(error).causes.some(
    (cause) =>
      cause.status === 429 ||
      cause.code === "429" ||
      /^\s*(?:HTTP\s+)?429\b/u.test(cause.message) ||
      (cause.code === "2018" && /rate limited/iu.test(cause.message)),
  );
}

const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 15 * 60_000;

const retryAfterHeader = (error: UnparsedError): string | null => {
  for (let current = error; current instanceof Error; current = current.cause)
    if (current instanceof GatewayHttpError) return current.retryAfter;
  return null;
};

/**
 * How long to wait before retrying a rate-limited AI Gateway call, or null
 * when the error is not a rate limit. Reads `Retry-After` (seconds or an HTTP
 * date) through any wrapping, defaults to a minute, and caps at fifteen.
 */
export function aiGatewayRateLimitDelayMs(
  error: UnparsedError,
  now = Date.now(),
): number | null {
  if (!isAiGatewayRateLimit(error)) return null;
  const header = retryAfterHeader(error)?.trim();
  const seconds = header && /^\d+$/u.test(header) ? Number(header) : null;
  const date = header && seconds === null ? Date.parse(header) : Number.NaN;
  const delay =
    seconds !== null
      ? seconds * 1000
      : Number.isNaN(date)
        ? DEFAULT_RATE_LIMIT_DELAY_MS
        : date - now;
  return Math.min(Math.max(delay, 1000), MAX_RATE_LIMIT_DELAY_MS);
}
