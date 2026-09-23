import {
  type AnthropicChatModelProviderOptionsByName,
  createAnthropicChat,
} from "@tanstack/ai-anthropic";
import {
  type OpenAITextProviderOptions,
  createOpenaiChat,
} from "@tanstack/ai-openai";
import {
  type OpenAICompatibleChatAdapter,
  openaiCompatibleText,
} from "@tanstack/ai-openai/compatible";

import {
  FAST_MODEL,
  REASONING_MODEL,
  type SupportedAiModelRef,
  type SupportedChatModel,
  VISION_BATCH_MODEL,
  getChatModelConfig,
  providerFor,
} from "~/server/ai/models";
import {
  type GatewayCallOptions,
  type GatewayMetadata,
  gatewayBaseURL,
  gatewayFetch,
} from "~/server/clients/ai-gateway";
import type { AiGatewayUsageContext } from "~/server/clients/ai-gateway-usage";

/**
 * The one cache lifetime deterministic structured calls get: the gateway's
 * own maximum (there is no shorter "safe default" worth choosing, and no
 * purge API to shorten a mistake). The cache key is the exact request body,
 * so a prompt or model change already mints a new key on its own — there's
 * nothing a shorter TTL would protect against that the key doesn't already.
 */
export const AI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * `{metadata, cacheTtlSeconds: AI_CACHE_TTL_SECONDS}` for a deterministic
 * structured call, or `{metadata, skipCache: true}` when `force` — the
 * escape hatch for a caller that needs a fresh answer (e.g. a "regenerate"
 * action) despite an identical request body.
 */
export function cachedCall(args: {
  metadata: GatewayMetadata;
  force?: boolean;
}): GatewayCallOptions {
  const { metadata, force } = args;
  return force
    ? { metadata, skipCache: true }
    : { metadata, cacheTtlSeconds: AI_CACHE_TTL_SECONDS };
}

/**
 * The placeholder the SDKs send as their provider credential. It never reaches
 * a provider: {@link gatewayFetch} strips `authorization` / `x-api-key` on both
 * the binding and the REST branch, leaving the gateway to authenticate with
 * BYOK or unified billing. The SDKs refuse to construct without *some* key.
 */
const UNIFIED_BILLING_PLACEHOLDER = "cf-aig-unified-billing";

/**
 * Claude Sonnet 5's wholesale pool meters tokens per minute and refuses bursts
 * with `429` code 2018, so the Anthropic client backs off rather than failing
 * the interactive call.
 */
const ANTHROPIC_MAX_RETRIES = 4;

/**
 * Adapters are built per call, never cached: the gateway binding is
 * per-request in prod, and the per-feature metadata lives in the shim's
 * closure. Construction is cheap.
 */
function anthropicAdapter<
  TModel extends Parameters<typeof createAnthropicChat>[0],
>(model: TModel, opts: GatewayCallOptions) {
  return createAnthropicChat(model, UNIFIED_BILLING_PLACEHOLDER, {
    baseURL: gatewayBaseURL("anthropic"),
    fetch: gatewayFetch("anthropic", opts),
    maxRetries: ANTHROPIC_MAX_RETRIES,
  });
}

function openaiAdapter<TModel extends Parameters<typeof createOpenaiChat>[0]>(
  model: TModel,
  opts: GatewayCallOptions,
) {
  return createOpenaiChat(model, UNIFIED_BILLING_PLACEHOLDER, {
    baseURL: gatewayBaseURL("openai"),
    fetch: gatewayFetch("openai", opts),
  });
}

// The installed TanStack catalog trails the provider's newly released ids.
// The Responses adapter sends its model argument verbatim; keep the cast at
// this boundary until TanStack adds GPT-6 to its type catalog.
function newOpenaiAdapter(
  model: typeof FAST_MODEL | typeof REASONING_MODEL,
  opts: GatewayCallOptions,
) {
  // SAFETY: TanStack forwards this literal id to Responses without parsing it;
  // the registry limits callers to GPT-6 ids verified through the gateway.
  return openaiAdapter(model as Parameters<typeof createOpenaiChat>[0], opts);
}

function compatAdapter<TModel extends string>(
  wireModel: TModel,
  opts: GatewayCallOptions,
) {
  const adapter = openaiCompatibleText(wireModel, {
    baseURL: gatewayBaseURL("compat"),
    apiKey: UNIFIED_BILLING_PLACEHOLDER,
    api: "chat-completions",
    fetch: gatewayFetch("compat", opts),
  });
  // SAFETY: `api` is optional in the factory's signature, so it returns a
  // Responses-or-Chat union; passing "chat-completions" always selects the
  // Chat Completions adapter. Narrowing here keeps the tier factories
  // concretely typed.
  return adapter as OpenAICompatibleChatAdapter<TModel>;
}

/**
 * GPT-6 Luna on `/openai/responses`: classification and identification.
 */
export function fastAdapter(opts: GatewayCallOptions) {
  return newOpenaiAdapter(getChatModelConfig(FAST_MODEL).wireModel, opts);
}

/**
 * Gemini 2.5 Flash on the gateway's `/compat/chat/completions`: the cheapest
 * accurate vision reader, but ~14 s to first token — batch and backfill work
 * only, never an interactive wait.
 */
export function visionBatchAdapter(opts: GatewayCallOptions) {
  return compatAdapter(getChatModelConfig(VISION_BATCH_MODEL).wireModel, opts);
}

/** GPT-6 Sol on `/openai/responses`: the accuracy tier. */
export function reasoningAdapter(opts: GatewayCallOptions) {
  return newOpenaiAdapter(getChatModelConfig(REASONING_MODEL).wireModel, opts);
}

/**
 * Any registered chat model, routed by the registry. The return type is a
 * union, which collapses `modelOptions` typing — use it only where the model
 * is chosen at runtime (the smoke test and the eval harness); features call a
 * tier factory.
 */
export function chatAdapterFor(
  model: SupportedChatModel,
  opts: GatewayCallOptions,
) {
  const config = getChatModelConfig(model);
  switch (config.route) {
    case "anthropic":
      // SAFETY: the registry's Anthropic route supplies provider wire ids;
      // TanStack's catalog predates Opus 5.5 but forwards the id unchanged.
      return anthropicAdapter(
        config.wireModel as Parameters<typeof createAnthropicChat>[0],
        opts,
      );
    case "openai-responses":
      // SAFETY: all registry rows on this route are OpenAI Responses ids;
      // TanStack's type catalog predates GPT-6 but forwards the id unchanged.
      return openaiAdapter(
        config.wireModel as Parameters<typeof createOpenaiChat>[0],
        opts,
      );
    case "compat":
      return compatAdapter(config.wireModel, opts);
  }
}

type AnthropicTierOptions =
  AnthropicChatModelProviderOptionsByName["claude-sonnet-5"];
export type AnthropicEffort = NonNullable<
  NonNullable<AnthropicTierOptions["output_config"]>["effort"]
>;

/**
 * Sonnet 5 rejects `temperature` / `top_p` / `top_k` and a manual
 * `budget_tokens`: send only the output cap, adaptive thinking, and the
 * effort dial. Thinking tokens count against `maxTokens`.
 */
export function anthropicOptions(args: {
  maxTokens: number;
  effort?: AnthropicEffort;
  /** From the registry row; `false` drops thinking and effort (Haiku 4.5). */
  adaptiveThinking?: boolean;
}): AnthropicTierOptions {
  if (args.adaptiveThinking === false) return { max_tokens: args.maxTokens };
  const options: AnthropicTierOptions = {
    max_tokens: args.maxTokens,
    thinking: { type: "adaptive" },
  };
  if (args.effort) options.output_config = { effort: args.effort };
  return options;
}

type OpenAiTierOptions = OpenAITextProviderOptions;
export type OpenAiEffort = NonNullable<
  NonNullable<OpenAiTierOptions["reasoning"]>["effort"]
>;

/** Luna's cap covers visible output plus reasoning tokens. */
export function openaiOptions(args: {
  maxTokens: number;
  effort: OpenAiEffort;
}): OpenAiTierOptions {
  return {
    max_output_tokens: args.maxTokens,
    reasoning: { effort: args.effort },
  };
}

/**
 * The compat route is plain Chat Completions, whose options the adapter
 * leaves untyped (`Record<string, any>`); this is the one place Cubby's
 * spelling of them is written down.
 */
interface CompatTierOptions {
  max_tokens: number;
  reasoning_effort?: "none" | "low" | "medium" | "high";
}

export type CompatEffort = NonNullable<CompatTierOptions["reasoning_effort"]>;

/**
 * The reasoning dial every route accepts — the intersection of the three
 * provider vocabularies, so a value typed this way is valid whichever tier a
 * caller (the eval harness) happens to route it to. OpenAI's `none`/`minimal`
 * and Anthropic's `max` are tier-specific and live on a feature record
 * instead.
 */
export type SharedEffort = OpenAiEffort & AnthropicEffort & CompatEffort;

export function compatOptions(args: {
  maxTokens: number;
  reasoningEffort?: CompatTierOptions["reasoning_effort"];
}): CompatTierOptions {
  const options: CompatTierOptions = { max_tokens: args.maxTokens };
  if (args.reasoningEffort) options.reasoning_effort = args.reasoningEffort;
  return options;
}

/**
 * The usage context for a call, with `provider` taken from the registry rather
 * than hardcoded — a non-Anthropic row with `provider: "anthropic"` would be
 * priced as `null` and vanish from the cost ledger.
 */
export function usageFor(
  model: SupportedChatModel,
  ctx: Omit<AiGatewayUsageContext, "provider" | "model">,
): AiGatewayUsageContext {
  // SAFETY: `SupportedAiModelRef` is a union of registry-derived
  // {provider, model} pairs and `providerFor` reads that same registry, but
  // the compiler cannot correlate them across a runtime-chosen model.
  const ref = { provider: providerFor(model), model } as SupportedAiModelRef;
  return { ...ctx, ...ref };
}
