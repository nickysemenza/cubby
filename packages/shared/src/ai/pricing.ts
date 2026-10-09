import {
  type CostTier,
  Models,
  type ModelCost,
  type Model,
  type ProviderMap,
} from "@opencode-ai/models";

import { getErrorMessage } from "../error-utils";
import { mapRecord, recordKeys } from "../record";
import { AI_MODELS, type AiModelId, type AiProvider } from "./models";

/**
 * AI model prices, read live from models.dev through its official client.
 * Cubby declares no rates: each declared model is priced by the catalog row
 * under its `catalogProvider` and exact id, and a model the catalog does not
 * price stays unpriced (`null`), never free. Pricing is usage telemetry, so a
 * catalog failure leaves telemetry unpriced. Paid admission quotes separately
 * refuse unknown prices or token bounds rather than authorizing an unknown cost.
 */

/** One declared model's stored vendor and its catalog price, if any. */
interface AiModelPrice {
  provider: AiProvider;
  cost: ModelCost | null;
  limit: Model["limit"] | null;
}

/** Each declared model's row under its own catalog provider; no fallback. */
export function projectAiModelPricing(providers: ProviderMap) {
  return mapRecord(recordKeys(AI_MODELS), (id): AiModelPrice => ({
    provider: AI_MODELS[id].provider,
    cost: providers[AI_MODELS[id].catalogProvider]?.models[id]?.cost ?? null,
    limit: providers[AI_MODELS[id].catalogProvider]?.models[id]?.limit ?? null,
  }));
}
export type AiModelPricing = Readonly<ReturnType<typeof projectAiModelPricing>>;

function decisionTokenBounds(limit: Model["limit"]) {
  if (
    !Number.isSafeInteger(limit.context) ||
    limit.context < 1 ||
    (limit.input !== undefined &&
      (!Number.isSafeInteger(limit.input) || limit.input < 1)) ||
    !Number.isSafeInteger(limit.output) ||
    limit.output < 0
  )
    return null;
  return {
    input: Math.max(limit.context, limit.input ?? limit.context),
    output: limit.output,
  };
}

function decisionQuoteRates(cost: ModelCost, inputWindow: number) {
  const tiers = cost.tiers ?? [];
  if (
    tiers.some(
      (rate) =>
        rate.tier.type !== "context" ||
        !Number.isSafeInteger(rate.tier.size) ||
        rate.tier.size < 0,
    )
  )
    return null;
  const rates = [
    cost,
    ...tiers.filter((rate) => rate.tier.size <= inputWindow),
    ...(inputWindow >= 200_000 && cost.context_over_200k
      ? [cost.context_over_200k]
      : []),
  ];
  const rateValues = rates.flatMap((rate) =>
    [
      rate.input,
      rate.output,
      rate.reasoning,
      rate.cache_read,
      rate.cache_write,
      rate.input_audio,
      rate.output_audio,
    ].filter((value) => value !== undefined),
  );
  if (rateValues.some((rate) => !Number.isFinite(rate) || rate < 0))
    return null;
  return {
    input: Math.max(
      ...rates.flatMap((rate) => [
        rate.input,
        rate.cache_read ?? 0,
        rate.cache_write ?? 0,
      ]),
    ),
    output: Math.max(
      ...rates.flatMap((rate) => [rate.output, rate.reasoning ?? 0]),
    ),
  };
}

/**
 * A conservative reservation for the exact declared model and role. Each
 * physical call may bill a full input/context window; byte lengths
 * and expected cache hits are not billing bounds. Explicit zero output rates
 * are valid for input-only decision models.
 */
function quoteAiRequest(
  pricing: AiModelPricing | null,
  request: { provider: string; model: string; questionCount: number },
  role: "decision" | "chat",
) {
  if (
    !pricing ||
    !Object.hasOwn(AI_MODELS, request.model) ||
    !Number.isSafeInteger(request.questionCount) ||
    request.questionCount < 1
  )
    return null;
  // SAFETY: the own-key check names exactly one declared model.
  const model = request.model as AiModelId;
  const declaration = AI_MODELS[model];
  const price = pricing[model];
  if (
    declaration.role !== role ||
    price?.provider !== request.provider ||
    !price.cost ||
    !price.limit
  )
    return null;
  const bounds = decisionTokenBounds(price.limit);
  if (!bounds) return null;
  const rates = decisionQuoteRates(price.cost, bounds.input);
  if (!rates) return null;
  const inputTokens = bounds.input * request.questionCount;
  const outputTokens =
    rates.output === 0 ? 0 : bounds.output * request.questionCount;
  const maxCostUsd =
    (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd < 0
  )
    return null;
  return {
    provider: price.provider,
    model,
    inputTokens,
    outputTokens,
    maxCostUsd,
  };
}

/** A decision can bill each question independently at full catalog bounds. */
export function quoteAiDecisionRequest(
  pricing: AiModelPricing | null,
  request: Parameters<typeof quoteAiRequest>[1],
) {
  return quoteAiRequest(pricing, request, "decision");
}

/** One physical chat call reserves the full priced input and output bounds. */
export function quoteAiChatRequest(
  pricing: AiModelPricing | null,
  request: Omit<Parameters<typeof quoteAiRequest>[1], "questionCount">,
) {
  return quoteAiRequest(pricing, { ...request, questionCount: 1 }, "chat");
}

export interface AiTokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Tokens served from the provider's prompt cache, when it reports them. */
  cacheReadTokens?: number | null;
  /** Tokens written into the provider's prompt cache, when it reports them. */
  cacheWriteTokens?: number | null;
}

function tokenCount(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? value
    : 0;
}

/**
 * What one recorded call cost in USD, or `null` when the model is not
 * declared, the recorded provider disagrees with it, no token counts were
 * reported, or the catalog cannot price every reported token class. A prompt
 * past a context tier's size is priced wholly at that tier's rates.
 */
export function estimateAiUsageCost(
  pricing: AiModelPricing | null,
  provider: string,
  model: string,
  usage: AiTokenUsage,
): number | null {
  const price =
    pricing && Object.hasOwn(pricing, model)
      ? // SAFETY: a projection holds exactly the declared model ids, so an
        // own key of `pricing` is an `AiModelId`.
        pricing[model as AiModelId]
      : undefined;
  if (!price?.cost || price.provider !== provider) return null;
  if (usage.inputTokens == null && usage.outputTokens == null) return null;

  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  const cacheRead = tokenCount(usage.cacheReadTokens);
  const cacheWrite = tokenCount(usage.cacheWriteTokens);
  const prompt = input + cacheRead + cacheWrite;
  const tier = (price.cost.tiers ?? [])
    .filter(
      (candidate) =>
        candidate.tier.type === "context" && prompt > candidate.tier.size,
    )
    .reduce<CostTier | undefined>(
      (widest, candidate) =>
        widest && widest.tier.size >= candidate.tier.size ? widest : candidate,
      undefined,
    );
  const rates = tier ?? price.cost;
  if (cacheRead > 0 && rates.cache_read === undefined) return null;
  if (cacheWrite > 0 && rates.cache_write === undefined) return null;
  return (
    (input * rates.input +
      output * rates.output +
      cacheRead * (rates.cache_read ?? 0) +
      cacheWrite * (rates.cache_write ?? 0)) /
    1_000_000
  );
}

interface AiModelPricingOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Diagnostics for a failed catalog read; the read itself resolves `null`. */
  onError: (error: Error) => void;
  timeoutMs?: number;
  /** How long a successful projection is reused. */
  ttlMs?: number;
  /** How long a failure is remembered before the next attempt. */
  failureBackoffMs?: number;
  now?: () => number;
}

/**
 * A cached live pricing source: one bounded catalog request at a time, a
 * successful projection reused for `ttlMs`, and a failure answered as `null`
 * (unknown) without another request for `failureBackoffMs`.
 */
export function createAiModelPricing(options: AiModelPricingOptions) {
  const client = Models.make({ fetch: options.fetch });
  const timeoutMs = options.timeoutMs ?? 5_000;
  const ttlMs = options.ttlMs ?? 60 * 60_000;
  const failureBackoffMs = options.failureBackoffMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  let cached: { pricing: AiModelPricing | null; until: number } | undefined;
  let inFlight: Promise<AiModelPricing | null> | undefined;

  async function load(): Promise<AiModelPricing | null> {
    try {
      // Decision models (Jev, Clef) are a specialized type the default
      // request omits.
      const providers = await client.providers({
        modelTypes: "all",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const pricing = projectAiModelPricing(providers);
      cached = { pricing, until: now() + ttlMs };
      return pricing;
    } catch (error) {
      options.onError(
        error instanceof Error
          ? error
          : new Error(getErrorMessage(error), { cause: error }),
      );
      cached = { pricing: null, until: now() + failureBackoffMs };
      return null;
    } finally {
      inFlight = undefined;
    }
  }

  return {
    /** The current projection, or `null` while the catalog is unavailable. */
    current(): Promise<AiModelPricing | null> {
      if (cached && now() < cached.until)
        return Promise.resolve(cached.pricing);
      return (inFlight ??= load());
    },
  };
}
