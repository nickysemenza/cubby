import type {
  Model,
  ModelCost,
  Provider,
  ProviderMap,
} from "@opencode-ai/models";
import { describe, expect, it, vi } from "vitest";

import {
  createAiModelPricing,
  estimateAiUsageCost,
  projectAiModelPricing,
} from "./pricing";

/** A synthetic models.dev `api.json`; rates are illustrative, not current. */
function catalog(): ProviderMap {
  const model = (id: string, cost: ModelCost): Model => ({
    id,
    name: id,
    description: "",
    attachment: false,
    reasoning: false,
    tool_call: false,
    release_date: "2026-01",
    last_updated: "2026-01",
    modalities: { input: ["text"], output: ["text"] },
    open_weights: false,
    limit: { context: 1_000_000, output: 100_000 },
    cost,
  });
  const provider = (
    id: string,
    costs: Record<string, ModelCost>,
  ): Provider => ({
    id,
    env: [],
    npm: "",
    name: id,
    doc: "",
    models: Object.fromEntries(
      Object.entries(costs).map(([modelId, cost]) => [
        modelId,
        model(modelId, cost),
      ]),
    ),
  });
  return {
    openai: provider("openai", {
      "gpt-6-sol": {
        input: 2,
        output: 10,
        cache_read: 0.2,
        cache_write: 2.5,
        tiers: [
          {
            input: 4,
            output: 15,
            cache_read: 0.4,
            cache_write: 5,
            tier: { type: "context", size: 272_000 },
          },
        ],
      },
      "text-embedding-3-small": { input: 0.02, output: 0 },
      // A same-id row under the wrong provider must never be selected.
      "typesafe/jev": { input: 99, output: 99 },
    }),
    "cloudflare-ai-gateway": provider("cloudflare-ai-gateway", {
      "typesafe/jev": { input: 0.042, output: 0, cache_read: 0 },
    }),
    "cloudflare-workers-ai": provider("cloudflare-workers-ai", {
      "@cf/cloudflare/clef": { input: 0.24, output: 0 },
    }),
    anthropic: provider("anthropic", {
      "claude-haiku-4-5": { input: 1, output: 5 },
    }),
    google: provider("google", {
      "gemini-2.5-flash": { input: 0.3, output: 2.5, cache_read: 0.03 },
      "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
    }),
  };
}

// Failure modes: a model priced under another provider's same-named row; a
// missing price booked as free; the stored vendor replaced by the catalog's
// provider id; cache tokens priced at zero when no cache rate exists.
describe("projectAiModelPricing", () => {
  const pricing = projectAiModelPricing(catalog());

  it("selects each model under its declared catalog provider, keeping the stored vendor", () => {
    expect(pricing["typesafe/jev"]).toEqual({
      provider: "typesafe",
      cost: { input: 0.042, output: 0, cache_read: 0 },
    });
    expect(pricing["@cf/cloudflare/clef"]?.provider).toBe("cloudflare");
  });

  it("leaves a model the catalog does not list unpriced, never free", () => {
    expect(pricing["claude-opus-5-5"]).toEqual({
      provider: "anthropic",
      cost: null,
    });
    expect(
      estimateAiUsageCost(pricing, "anthropic", "claude-opus-5-5", {
        inputTokens: 1000,
      }),
    ).toBeNull();
  });
});

describe("estimateAiUsageCost", () => {
  const pricing = projectAiModelPricing(catalog());

  it("prices base and cache token classes", () => {
    expect(
      estimateAiUsageCost(pricing, "openai", "gpt-6-sol", {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 10_000,
      }),
    ).toBeCloseTo(0.039, 8);
    expect(
      estimateAiUsageCost(pricing, "typesafe", "typesafe/jev", {
        inputTokens: 1_000_000,
        outputTokens: 50,
      }),
    ).toBeCloseTo(0.042, 6);
    expect(
      estimateAiUsageCost(pricing, "openai", "text-embedding-3-small", {
        inputTokens: 45,
        outputTokens: null,
      }),
    ).toBeCloseTo(0.0000009);
  });

  // Cookbook's pinned ladder bills Gemini calls to `google-ai-studio`, which
  // models.dev prices under its `google` provider.
  it("prices the cookbook's Gemini models billed to google-ai-studio", () => {
    expect(
      estimateAiUsageCost(pricing, "google-ai-studio", "gemini-2.5-flash", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.3 + 2.5 + 0.03, 8);
    expect(
      estimateAiUsageCost(
        pricing,
        "google-ai-studio",
        "gemini-2.5-flash-lite",
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      ),
    ).toBeCloseTo(0.1 + 0.4, 8);
  });

  it("prices a prompt above a context tier at that tier's rates", () => {
    expect(
      estimateAiUsageCost(pricing, "openai", "gpt-6-sol", {
        inputTokens: 200_000,
        cacheReadTokens: 100_000,
        outputTokens: 1000,
      }),
    ).toBeCloseTo(0.2 * 4 + 0.1 * 0.4 + 0.001 * 15, 8);
  });

  it("refuses cache tokens the catalog has no rate for", () => {
    expect(
      estimateAiUsageCost(pricing, "anthropic", "claude-haiku-4-5", {
        inputTokens: 1000,
        cacheReadTokens: 1000,
      }),
    ).toBeNull();
  });

  it("leaves unknown, mismatched, or tokenless rows unpriced", () => {
    expect(
      estimateAiUsageCost(pricing, "example", "unknown-model", {
        inputTokens: 1000,
      }),
    ).toBeNull();
    expect(
      estimateAiUsageCost(pricing, "typesafe", "@cf/cloudflare/clef", {
        inputTokens: 1000,
      }),
    ).toBeNull();
    expect(
      estimateAiUsageCost(pricing, "openai", "gpt-6-sol", {
        inputTokens: null,
        outputTokens: undefined,
      }),
    ).toBeNull();
  });
});

// Failure modes: decision models silently dropped by the default catalog
// filter; a slow catalog stalling the usage writer; concurrent writers each
// downloading it; a failing catalog retried on every row.
describe("createAiModelPricing", () => {
  function catalogFetch(response: () => Promise<Response>) {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return response();
    });
    return { fetch, urls };
  }

  it("requests every model type, including decision models", async () => {
    const { fetch, urls } = catalogFetch(async () => Response.json(catalog()));
    const pricing = createAiModelPricing({ fetch, onError: () => {} });
    expect((await pricing.current())?.["typesafe/jev"]?.cost).not.toBeNull();
    expect(new URL(urls[0] ?? "").searchParams.get("type")).toBe("all");
  });

  it("shares one in-flight request and caches a success until its TTL", async () => {
    let now = 0;
    const { fetch } = catalogFetch(async () => Response.json(catalog()));
    const pricing = createAiModelPricing({
      fetch,
      now: () => now,
      ttlMs: 1000,
      onError: () => {},
    });
    await Promise.all([pricing.current(), pricing.current()]);
    await pricing.current();
    expect(fetch).toHaveBeenCalledOnce();
    now = 1001;
    await pricing.current();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a failure as unknown once, and backs off instead of retrying per row", async () => {
    let now = 0;
    const errors: Error[] = [];
    const { fetch } = catalogFetch(
      async () => new Response("synthetic outage", { status: 503 }),
    );
    const pricing = createAiModelPricing({
      fetch,
      now: () => now,
      failureBackoffMs: 500,
      onError: (error) => errors.push(error),
    });
    expect(await pricing.current()).toBeNull();
    expect(await pricing.current()).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    now = 501;
    await pricing.current();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up on a catalog that does not answer within its timeout", async () => {
    const errors: Error[] = [];
    const fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const pricing = createAiModelPricing({
      fetch,
      timeoutMs: 10,
      onError: (error) => errors.push(error),
    });
    expect(await pricing.current()).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
