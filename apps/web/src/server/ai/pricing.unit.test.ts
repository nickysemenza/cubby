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
