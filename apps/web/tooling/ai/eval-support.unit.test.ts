import { projectAiModelPricing } from "@cubby/shared/ai/pricing";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it } from "vitest";

import {
  evalCandidates,
  evalCostEstimator,
  type EvalUsage,
} from "./eval-support";

// Failure modes: cached input is billed twice (Responses reports it inside
// `input_tokens`); an unpriced model is reported as free; a candidate the
// Responses-only model peer cannot carry runs on the wrong protocol.

// Synthetic rates (USD per million); Luna is deliberately absent.
const pricing = projectAiModelPricing(
  fromPartial({
    openai: {
      models: {
        "gpt-6-sol": {
          cost: {
            input: 2,
            output: 10,
            cache_read: 0.2,
            tiers: [
              {
                tier: { type: "context", size: 272000 },
                input: 4,
                output: 20,
                cache_read: 0.4,
              },
            ],
          },
        },
      },
    },
  }),
);
const evalCostUsd = evalCostEstimator({ current: async () => pricing });

const usage: EvalUsage = {
  requests: 2,
  failedRequests: 0,
  inputTokens: 1_000,
  cachedInputTokens: 400,
  outputTokens: 50,
  reasoningTokens: 20,
  modelMs: 900,
  calls: [
    { inputTokens: 500, cachedInputTokens: 200, outputTokens: 25 },
    { inputTokens: 500, cachedInputTokens: 200, outputTokens: 25 },
  ],
};

it("prices inclusive cached input once, as its own class", async () => {
  // 600 uncached x 2 + 400 cached x 0.2 + 50 output x 10, per million.
  await expect(evalCostUsd("gpt-6-sol", usage)).resolves.toBeCloseTo(
    0.00178,
    10,
  );
});

it("keeps an unpriced model unpriced", async () => {
  await expect(evalCostUsd("gpt-6-luna", usage)).resolves.toBeNull();
});

it("rejects a candidate outside the OpenAI Responses peer", () => {
  expect(evalCandidates("gpt-6-luna:high")).toEqual([
    { model: "gpt-6-luna", effort: "high" },
  ]);
  expect(() => evalCandidates("claude-haiku-4-5:high")).toThrow(
    /OpenAI Responses/u,
  );
});

it("selects context tiers per request rather than on the combined run", async () => {
  const run = {
    ...usage,
    inputTokens: 300_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    calls: [
      { inputTokens: 150_000, cachedInputTokens: 0, outputTokens: 0 },
      { inputTokens: 150_000, cachedInputTokens: 0, outputTokens: 0 },
    ],
  };
  await expect(evalCostUsd("gpt-6-sol", run)).resolves.toBeCloseTo(0.6);
});

it("keeps a failed request without usage unpriced", async () => {
  await expect(
    evalCostUsd("gpt-6-sol", {
      ...usage,
      requests: 1,
      failedRequests: 1,
      calls: [],
    }),
  ).resolves.toBeNull();
});
