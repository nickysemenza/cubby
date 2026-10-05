import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { CF_ACCOUNT_ID, CF_AIG_GATEWAY_ID } from "~/server/cf-env";

import { localSecret } from "../../../tooling/local-secret";

/**
 * Shared plumbing for the opt-in, billed import-run agent evals: the
 * candidate list, the `tooling/agent-eval-model.ts` proxy that forwards the
 * agent's model calls to Cubby's AI Gateway as each candidate, and its usage
 * and cost accounting.
 */
export const evalWebRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const candidate = z.object({
  model: z.enum(["gpt-6-luna", "gpt-6-sol"]),
  effort: z.enum(["none", "low", "medium", "high"]),
});
export type EvalCandidate = z.infer<typeof candidate>;

export function evalCandidates(fallback: string): EvalCandidate[] {
  return (process.env.AGENT_EVAL_CANDIDATES ?? fallback)
    .split(",")
    .map((entry) => {
      const [model, effort] = entry.split(":");
      return candidate.parse({ model, effort });
    });
}

/** USD per million tokens, from OpenAI's standard-tier pricing page. */
const PRICES = {
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
} satisfies Record<
  EvalCandidate["model"],
  { input: number; cachedInput: number; output: number }
>;

export const evalUsageReport = z.object({
  requests: z.number(),
  failedRequests: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  modelMs: z.number(),
});
export type EvalUsage = z.infer<typeof evalUsageReport>;

export function evalCostUsd(model: EvalCandidate["model"], usage: EvalUsage) {
  const price = PRICES[model];
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  return (
    (uncached * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.outputTokens * price.output) /
    1_000_000
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
    GATEWAY_OPENAI_URL: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AIG_GATEWAY_ID}/openai`,
  },
  secrets: { AI_GATEWAY_API_KEY: gatewayApiKey() },
});
