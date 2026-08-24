import { describe, expect, it } from "vitest";
import { estimateAiUsageCostUsd, parseSupportedEmbeddingModel } from "./models";

describe("AI model pricing", () => {
  it("estimates Claude Haiku 4.5 usage from input and output tokens", () => {
    expect(
      estimateAiUsageCostUsd("anthropic", "claude-haiku-4-5", {
        inputTokens: 1826,
        outputTokens: 115,
      }),
    ).toBeCloseTo(0.002401);
  });

  it("estimates Claude Sonnet 4.6 usage from input and output tokens", () => {
    expect(
      estimateAiUsageCostUsd("anthropic", "claude-sonnet-4-6", {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeCloseTo(0.018);
  });

  it("estimates text-embedding-3-small usage from input tokens", () => {
    expect(
      estimateAiUsageCostUsd("openai", "text-embedding-3-small", {
        inputTokens: 45,
        outputTokens: null,
      }),
    ).toBeCloseTo(0.0000009);
  });

  it("leaves unknown or provider-mismatched models unpriced", () => {
    expect(
      estimateAiUsageCostUsd("example", "unknown-model", {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeNull();
    expect(
      estimateAiUsageCostUsd("openai", "claude-haiku-4-5", {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeNull();
  });

  it("rejects unsupported embedding models before provider calls", () => {
    expect(() => parseSupportedEmbeddingModel("claude-haiku-4-5")).toThrow(
      /Unsupported embedding model/,
    );
  });
});
