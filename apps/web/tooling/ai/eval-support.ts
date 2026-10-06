import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CF_ACCOUNT_ID,
  testAiGatewayEnvironment,
} from "@cubby/shared/ai/gateway-metadata";
import {
  createAiModelPricing,
  estimateAiUsageCost,
} from "@cubby/shared/ai/pricing";
import { providerFor } from "@cubby/shared/ai/models";
import { z } from "zod";

import { localSecret } from "../local-secret";
import { type ModelSwap, modelSwapSchema } from "../responses-model-swap";

/**
 * Shared plumbing for the opt-in, billed model evals: the candidate list, the
 * `tooling/agent-eval-model.ts` proxy that forwards the agent's model calls to
 * Cubby's AI Gateway as each candidate, and its usage and cost accounting.
 */
export const evalWebRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Candidates run through the OpenAI Responses model peer only. */
export type EvalCandidate = ModelSwap;

export function evalCandidates(fallback: string): EvalCandidate[] {
  return (process.env.AGENT_EVAL_CANDIDATES ?? fallback)
    .split(",")
    .map((entry) => {
      const [model, effort] = entry.split(":");
      return modelSwapSchema.parse({ model, effort });
    });
}

export const evalUsageReport = z.object({
  requests: z.number(),
  failedRequests: z.number(),
  /** Responses-style: includes `cachedInputTokens`. */
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  modelMs: z.number(),
  calls: z.array(
    z.object({
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      outputTokens: z.number(),
    }),
  ),
});
export type EvalUsage = z.infer<typeof evalUsageReport>;

type PricingSource = Pick<ReturnType<typeof createAiModelPricing>, "current">;

/** Costs a candidate's calls from `pricing`; tests pass a fixed projection. */
export function evalCostEstimator(pricing: PricingSource) {
  /** USD, or `null` when the catalog cannot price the calls. */
  return async (
    model: EvalCandidate["model"],
    usage: EvalUsage,
  ): Promise<number | null> => {
    if (usage.calls.length !== usage.requests) return null;
    const catalog = await pricing.current();
    const costs = usage.calls.map((call) =>
      estimateAiUsageCost(catalog, providerFor(model), model, {
        inputTokens: call.inputTokens - call.cachedInputTokens,
        cacheReadTokens: call.cachedInputTokens,
        outputTokens: call.outputTokens,
      }),
    );
    return costs.some((cost) => cost === null)
      ? null
      : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  };
}

export const evalCostUsd = evalCostEstimator(
  createAiModelPricing({
    onError: (error) =>
      console.warn("[eval] models.dev pricing unavailable", error),
  }),
);

/** A candidate's mean cost; one unpriced run leaves the mean unpriced. */
export function meanEvalCostUsd(costs: readonly (number | null)[]) {
  if (costs.some((cost) => cost === null)) return null;
  const priced = costs.filter((cost) => cost !== null);
  return (
    priced.reduce((sum, cost) => sum + cost, 0) / Math.max(1, priced.length)
  );
}

function gatewayApiKey() {
  const key = localSecret(["AI_GATEWAY_API_KEY"]);
  if (!key) throw new Error("AI_GATEWAY_API_KEY is required for the live eval");
  return key;
}

/** The harness model worker that bills each candidate through the Gateway. */
export const liveEvalModelWorker = () => ({
  main: "tooling/agent-eval-model.ts",
  vars: {
    ACCOUNT_ID: CF_ACCOUNT_ID,
    // A paid eval is never production traffic.
    GATEWAY_ENVIRONMENT: testAiGatewayEnvironment(process.env.CI),
  },
  secrets: { AI_GATEWAY_API_KEY: gatewayApiKey() },
});
