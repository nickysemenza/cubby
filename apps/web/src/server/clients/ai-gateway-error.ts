import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";

import type { GatewayResponseFailure } from "./ai-gateway";

class GatewayHttpError extends Error {
  readonly status: number;

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
  }
}

/** Keep request identity next to the provider's original error and stack. */
export class AiGatewayRequestError extends Error {
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
  return new AiGatewayRequestError(
    `AI Gateway request failed (model: ${context.model}, provider: ${context.provider}, route: ${context.route}, feature: ${context.feature}, operation: ${context.operation}${log}): ${reason}`,
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
