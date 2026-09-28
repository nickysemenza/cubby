import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";

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
): Error {
  const log = context.gatewayLogId
    ? `, gateway log: ${context.gatewayLogId}`
    : "";
  const reason = error instanceof Error ? error.message : String(error);
  return new AiGatewayRequestError(
    `AI Gateway request failed (model: ${context.model}, provider: ${context.provider}, route: ${context.route}, feature: ${context.feature}, operation: ${context.operation}${log}): ${reason}`,
    error,
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
