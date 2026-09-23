import { importRunId } from "@cubby/schemas/identifiers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FAST_MODEL,
  REASONING_MODEL,
  VISION_BATCH_MODEL,
} from "~/server/ai/models";
import type { Database } from "~/server/db";

import {
  AI_CACHE_TTL_SECONDS,
  anthropicOptions,
  cachedCall,
  chatAdapterFor,
  compatOptions,
  fastAdapter,
  openaiOptions,
  reasoningAdapter,
  usageFor,
  visionBatchAdapter,
} from "./ai-adapters";

// Constructing an adapter must never need a gateway: the shim resolves the
// binding per request, and dev has none.
afterEach(() => {
  vi.unstubAllEnvs();
});

const opts = { metadata: { feature: "test" } };

describe("tier factories resolve the registry's wire model and route", () => {
  it("sends the fast tier to OpenAI's Responses API", () => {
    const adapter = fastAdapter(opts);
    expect(adapter.name).toBe("openai");
    expect(adapter.model).toBe("gpt-6-luna");
  });

  it("sends the vision batch tier to the gateway's compat route", () => {
    const adapter = visionBatchAdapter(opts);
    expect(adapter.model).toBe("google-ai-studio/gemini-2.5-flash");
  });

  it("sends the reasoning tier to OpenAI Responses", () => {
    const adapter = reasoningAdapter(opts);
    expect(adapter.name).toBe("openai");
    expect(adapter.model).toBe("gpt-6-sol");
  });

  it("routes any registered model the same way through chatAdapterFor", () => {
    expect(chatAdapterFor(FAST_MODEL, opts).model).toBe(
      fastAdapter(opts).model,
    );
    expect(chatAdapterFor(VISION_BATCH_MODEL, opts).model).toBe(
      visionBatchAdapter(opts).model,
    );
    expect(chatAdapterFor(REASONING_MODEL, opts).model).toBe(
      reasoningAdapter(opts).model,
    );
    expect(chatAdapterFor("claude-haiku-4-5", opts).name).toBe("anthropic");
  });
});

describe("provider option helpers", () => {
  it("never emits sampling parameters for Anthropic (Sonnet 5 rejects them)", () => {
    const options = anthropicOptions({ maxTokens: 4000, effort: "low" });
    expect(options).toEqual({
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("top_p");
    expect(options).not.toHaveProperty("top_k");
    expect(anthropicOptions({ maxTokens: 300 })).not.toHaveProperty(
      "output_config",
    );
  });

  it("drops thinking and effort for models that reject them", () => {
    const options = anthropicOptions({
      maxTokens: 300,
      effort: "low",
      adaptiveThinking: false,
    });
    expect(options).toEqual({ max_tokens: 300 });
  });

  it("caps Luna's visible plus reasoning output", () => {
    expect(openaiOptions({ maxTokens: 500, effort: "none" })).toEqual({
      max_output_tokens: 500,
      reasoning: { effort: "none" },
    });
  });

  it("spells the compat route's chat-completions parameters", () => {
    expect(compatOptions({ maxTokens: 800 })).toEqual({ max_tokens: 800 });
    expect(compatOptions({ maxTokens: 800, reasoningEffort: "none" })).toEqual({
      max_tokens: 800,
      reasoning_effort: "none",
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

describe("usageFor", () => {
  // SAFETY: the usage context only carries the database to the middleware,
  // which this test never runs.
  const db = {} as Database;
  const runId = importRunId.parse("00000000-0000-4000-8000-000000000001");

  it("derives the provider from the registry rather than assuming Anthropic", () => {
    expect(
      usageFor(FAST_MODEL, { db, runId, feature: "f", operation: "o" }),
    ).toMatchObject({ provider: "openai", model: "gpt-6-luna" });
    expect(
      usageFor(VISION_BATCH_MODEL, { db, runId, feature: "f", operation: "o" }),
    ).toMatchObject({ provider: "google", model: "gemini-2.5-flash" });
    expect(
      usageFor(REASONING_MODEL, { db, runId, feature: "f", operation: "o" }),
    ).toMatchObject({ provider: "openai", model: "gpt-6-sol" });
  });
});
