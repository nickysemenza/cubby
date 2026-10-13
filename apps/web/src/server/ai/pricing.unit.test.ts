import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A fresh isolate's pricing cache, reading the stubbed catalog. */
async function freshEstimate(catalog: () => Promise<Response>) {
  const fetch = vi.fn(catalog);
  vi.stubGlobal("fetch", fetch);
  vi.resetModules();
  return { fetch, ...(await import("./pricing")) };
}

// Pricing is telemetry: an unavailable catalog must leave a usage row
// unpriced rather than fail the write that records a finished model call.
describe("estimateAiUsageCostUsd", () => {
  it("prices from the live catalog under the model's declared provider", async () => {
    const { estimateAiUsageCostUsd } = await freshEstimate(async () =>
      Response.json({
        "cloudflare-ai-gateway": {
          id: "cloudflare-ai-gateway",
          models: {
            "typesafe/jev": {
              id: "typesafe/jev",
              cost: { input: 0.5, output: 0 },
            },
          },
        },
      }),
    );
    expect(
      await estimateAiUsageCostUsd("typesafe", "typesafe/jev", {
        inputTokens: 1_000_000,
        outputTokens: 50,
      }),
    ).toBeCloseTo(0.5, 6);
  });

  it("leaves rows unpriced while the catalog is unavailable", async () => {
    const { estimateAiUsageCostUsd, fetch } = await freshEstimate(async () => {
      throw new Error("synthetic network failure");
    });
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    await expect(
      estimateAiUsageCostUsd("openai", "gpt-6-luna", usage),
    ).resolves.toBeNull();
    await expect(
      estimateAiUsageCostUsd("openai", "gpt-6-luna", usage),
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it("retries required legacy pricing on a real catalog outage while ordinary telemetry stays soft", async () => {
  const { snapshotAiUsagePrice, fetch } = await freshEstimate(async () => {
    throw new Error("synthetic catalog outage");
  });
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  await expect(
    snapshotAiUsagePrice("openai", "gpt-6-sol", usage),
  ).resolves.toMatchObject({ amount: null, evidence: null });
  await expect(
    snapshotAiUsagePrice("openai", "gpt-6-sol", usage, {
      requireCatalog: true,
    }),
  ).rejects.toThrow(/catalog unavailable/i);
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps unknown models unpriced with a healthy required catalog", async () => {
  const { snapshotAiUsagePrice } = await freshEstimate(async () =>
    Response.json({}),
  );
  await expect(
    snapshotAiUsagePrice(
      "openai",
      "synthetic-unpriced",
      { inputTokens: 1000, outputTokens: 0 },
      { requireCatalog: true },
    ),
  ).resolves.toMatchObject({ amount: null, evidence: null });
});
