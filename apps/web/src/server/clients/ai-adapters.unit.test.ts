import { afterEach, describe, expect, it, vi } from "vitest";

import { FAST_MODEL } from "~/server/ai/models";

import {
  AI_CACHE_TTL_SECONDS,
  cachedCall,
  chatCompletionOptionsFor,
  piCallTarget,
} from "./ai-adapters";

// Constructing a call target must never need a gateway: the shim resolves
// the binding per request, and dev has none.
afterEach(() => {
  vi.unstubAllEnvs();
});

const opts = { metadata: { feature: "test", operation: "adapter.routing" } };

describe("piCallTarget resolves the registry's wire model and route", () => {
  it("sends the fast tier to OpenAI's Responses API", () => {
    const target = piCallTarget(FAST_MODEL, opts);
    expect(target.model.provider).toBe("openai");
    expect(target.model.id).toBe("gpt-6-luna");
  });

  it("routes Anthropic models to the anthropic provider", () => {
    expect(piCallTarget("claude-haiku-4-5", opts).model.provider).toBe(
      "anthropic",
    );
  });
});

describe("chatCompletionOptionsFor", () => {
  it("never emits sampling parameters for Anthropic (Sonnet 5 rejects them)", () => {
    const options = chatCompletionOptionsFor(
      "claude-sonnet-5",
      { maxTokens: 4000, effort: "low" },
      "respond",
    );
    expect(options).toEqual({
      maxTokens: 4000,
      thinkingEnabled: true,
      effort: "low",
      toolChoice: { type: "tool", name: "respond" },
    });
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("top_p");
    expect(options).not.toHaveProperty("top_k");
    expect(
      chatCompletionOptionsFor(
        "claude-sonnet-5",
        { maxTokens: 300 },
        "respond",
      ),
    ).not.toHaveProperty("effort");
  });

  it("drops thinking and effort for models that reject them", () => {
    const options = chatCompletionOptionsFor(
      "claude-haiku-4-5",
      { maxTokens: 300, effort: "low" },
      "respond",
    );
    expect(options).toEqual({
      maxTokens: 300,
      toolChoice: { type: "tool", name: "respond" },
    });
  });

  it("caps Luna's visible plus reasoning output and forces the named function tool", () => {
    expect(
      chatCompletionOptionsFor(
        FAST_MODEL,
        { maxTokens: 500, effort: "none" },
        "respond",
      ),
    ).toEqual({
      maxTokens: 500,
      reasoningEffort: "none",
      toolChoice: { type: "function", name: "respond" },
    });
  });
});

describe("cachedCall", () => {
  const metadata = { feature: "usda-match", operation: "select" };

  it("caches at the gateway's maximum TTL by default", () => {
    expect(cachedCall({ metadata })).toEqual({
      metadata,
      cacheTtlSeconds: AI_CACHE_TTL_SECONDS,
    });
    expect(AI_CACHE_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("skips the cache instead when force is set", () => {
    expect(cachedCall({ metadata, force: true })).toEqual({
      metadata,
      skipCache: true,
    });
  });

  it("caches (does not skip) when force is explicitly false", () => {
    expect(cachedCall({ metadata, force: false })).toEqual({
      metadata,
      cacheTtlSeconds: AI_CACHE_TTL_SECONDS,
    });
  });
});
