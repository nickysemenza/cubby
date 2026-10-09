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
 * Shared plumbing for opt-in model evals: the candidate list, the
 * `tooling/agent-eval-model.ts` proxy that forwards the agent's model calls to
 * Cubby's AI Gateway or required subscription as each candidate, and usage
 * and separately billed cost accounting.
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
  transport: z.enum(["chatgpt", "gateway"]).optional(),
  failures: z
    .array(
      z.object({
        stage: z.enum(["http", "transport", "stream"]),
        status: z.number().int().optional(),
        message: z.string().max(2000),
      }),
    )
    .max(8)
    .optional(),
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
    if (usage.transport === "chatgpt") return 0;
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

const evalPricing = createAiModelPricing({
  onError: (error) =>
    console.warn("[eval] models.dev pricing unavailable", error),
});
export const evalCostUsd = evalCostEstimator(evalPricing);

/** Subscription output caps are stripped; reserve the exact catalog maximum. */
export async function evalSubscriptionOutputTokens(
  model: EvalCandidate["model"],
) {
  const catalog = await evalPricing.current();
  const maximum = catalog?.[model]?.limit?.output;
  if (!Number.isSafeInteger(maximum) || !maximum || maximum < 1)
    throw new Error(
      `Subscription evaluation lacks a finite output bound for ${model}`,
    );
  return maximum;
}

export const subscriptionEvalModelWorker = (origin: string) => ({
  main: "tooling/agent-eval-model.ts",
  vars: {
    ACCOUNT_ID: CF_ACCOUNT_ID,
    AI_GATEWAY_API_KEY: "",
    GATEWAY_ENVIRONMENT: testAiGatewayEnvironment(process.env.CI),
    SUBSCRIPTION_REQUIRED: "true",
    SUBSCRIPTION_PROVIDER_URL: origin,
  },
});

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
