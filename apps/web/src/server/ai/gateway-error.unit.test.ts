import { describe, expect, it } from "vitest";

import {
  aiGatewayRateLimitDelayMs,
  isAiGatewayRateLimit,
  wrapAiGatewayError,
} from "./gateway-error";

const context = {
  model: "synthetic-model",
  provider: "openai",
  route: "openai-responses",
  feature: "synthetic-classification",
  operation: "classify",
};
const rateLimited = (retryAfter: string | null) =>
  new Error("Gmail page retrieval failed", {
    cause: wrapAiGatewayError(new Error("generic"), context, {
      status: 429,
      statusText: "Too Many Requests",
      body: "{}",
      retryAfter,
    }),
  });

describe("AI Gateway error context", () => {
  it("shows the HTTP failure when the provider adapter only reports a generic message", () => {
    const error = wrapAiGatewayError(
      new Error("An error occurred while processing the request."),
      {
        model: "synthetic-model",
        provider: "openai",
        route: "openai-responses",
        feature: "synthetic-classification",
        operation: "classify",
      },
      {
        status: 429,
        statusText: "Too Many Requests",
        body: '{"error":{"message":"Synthetic quota reached"}}',
        retryAfter: "30",
      },
    );
    expect(error.message).toContain("HTTP 429");
    expect(error.message).toContain("Synthetic quota reached");
    expect(isAiGatewayRateLimit(error)).toBe(true);
  });

  // A Workflow sleeps exactly this long instead of spending a step retry.
  it("reads Retry-After through wrapping as seconds or an HTTP date", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    expect(aiGatewayRateLimitDelayMs(rateLimited("30"), now)).toBe(30_000);
    expect(
      aiGatewayRateLimitDelayMs(
        rateLimited("Mon, 05 Oct 2026 12:02:00 GMT"),
        now,
      ),
    ).toBe(120_000);
  });

  it("falls back to a bounded wait and ignores other failures", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    expect(aiGatewayRateLimitDelayMs(rateLimited(null), now)).toBe(60_000);
    expect(aiGatewayRateLimitDelayMs(rateLimited("86400"), now)).toBe(
      15 * 60_000,
    );
    expect(aiGatewayRateLimitDelayMs(rateLimited("garbage"), now)).toBe(60_000);
    expect(aiGatewayRateLimitDelayMs(new Error("HTTP 500"), now)).toBeNull();
  });
});
