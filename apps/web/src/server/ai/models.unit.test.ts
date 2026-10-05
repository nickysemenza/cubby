import { describe, expect, it } from "vitest";

import {
  catalogedModels,
  DECISION_MODEL,
  estimateAiUsageCostUsd,
  FAST_MODEL,
  getAiModelCatalog,
  getChatModelConfig,
  parseSupportedEmbeddingModel,
  providerFor,
} from "./models";

// Real WASM: the crate catalog is the app's only chat price source, so these
// assert against the shipped `wasm.model_catalog()` rather than a fixture.
describe("the crate catalog backs every registered chat model", () => {
  it("prices every registered chat id", () => {
    const catalog = getAiModelCatalog();
    for (const model of catalogedModels()) {
      const entry = catalog.get(model);
      expect(
        entry,
        `${model} is missing from wasm.model_catalog()`,
      ).toBeDefined();
      expect(entry?.rates, `${model} has no rates`).toBeTruthy();
    }
  });

  it("prices the fast tier from the catalog", () => {
    expect(
      estimateAiUsageCostUsd(providerFor(FAST_MODEL), FAST_MODEL, {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBeGreaterThan(0);
  });

  it("prices the decision tier's free output at zero, not as unknown", () => {
    expect(
      estimateAiUsageCostUsd("typesafe", DECISION_MODEL, {
        inputTokens: 1_000_000,
        outputTokens: 50,
      }),
    ).toBeCloseTo(0.042, 6);
  });

  it("prices provider-specific cache reads and writes", () => {
    expect(
      estimateAiUsageCostUsd("openai", "gpt-6-sol", {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 10_000,
      }),
    ).toBeCloseTo(0.039, 8);
  });
});

describe("the registry is the routing seam", () => {
  it("routes each tier to its provider and wire format", () => {
    expect(getChatModelConfig(FAST_MODEL)).toMatchObject({
      provider: "openai",
      route: "openai-responses",
      wireModel: "gpt-6-luna",
    });
  });
});

describe("AI model pricing", () => {
  it("prices Clef input and free output under the actual Cloudflare provider", () => {
    expect(
      estimateAiUsageCostUsd("cloudflare", "@cf/cloudflare/clef", {
        inputTokens: 1_000_000,
        outputTokens: 50,
      }),
    ).toBeCloseTo(0.24, 6);
    expect(
      estimateAiUsageCostUsd("typesafe", "@cf/cloudflare/clef", {
        inputTokens: 1_000_000,
      }),
    ).toBeNull();
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
