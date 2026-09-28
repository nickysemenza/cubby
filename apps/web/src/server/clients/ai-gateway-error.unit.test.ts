import { describe, expect, it } from "vitest";

import { isAiGatewayRateLimit, wrapAiGatewayError } from "./ai-gateway-error";

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
});
