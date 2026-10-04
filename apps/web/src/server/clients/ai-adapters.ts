import { cubbyPiProviders, type GatewayRoute } from "@cubby/shared/pi-gateway";
import {
  createModels,
  type Api,
  type AnthropicOptions,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsApiStreamOptions,
  type OpenAICompletionsOptions,
  type OpenAIResponsesOptions,
} from "@earendil-works/pi-ai";

import {
  type ChatRoute,
  type SupportedChatModel,
  adaptiveThinkingFor,
  getChatModelConfig,
} from "~/server/ai/models";
import {
  type GatewayCallOptions,
  type GatewayMetadata,
  gatewayFetch,
} from "~/server/clients/ai-gateway";

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

/** The registry's chat route, translated to the shared gateway module's provider id. */
function gatewayRouteFor(route: ChatRoute): GatewayRoute {
  switch (route) {
    case "openai-responses":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "compat":
      return "compat";
  }
}

/** A chat model resolved against pi-ai's catalog, plus a `complete()` bound to it. */
export interface PiCallTarget {
  model: Model<Api>;
  complete: (
    context: Context,
    options: ModelsApiStreamOptions<Api>,
  ) => Promise<AssistantMessage>;
}

/**
 * Builds a fresh pi-ai `Models` collection per call: the gateway's per-call
 * metadata and cache policy (`call`) live in the provider's fetch closure
 * (`cubbyPiProviders`'s doc comment), so a provider cannot be shared across
 * calls with different `GatewayCallOptions`. Construction is cheap — no
 * network I/O, just object literals — so a fresh collection per call is the
 * correct cost, not a corner cut for simplicity.
 */
export function piCallTarget(
  model: SupportedChatModel,
  call: GatewayCallOptions,
): PiCallTarget {
  const config = getChatModelConfig(model);
  const gatewayRoute = gatewayRouteFor(config.route);
  const models = createModels();
  for (const provider of cubbyPiProviders((route) =>
    gatewayFetch(route, call),
  )) {
    models.setProvider(provider);
  }
  const resolved = models.getModel(gatewayRoute, config.wireModel);
  if (!resolved) {
    throw new Error(
      `pi-ai does not declare a model for ${gatewayRoute}/${config.wireModel} (Cubby model "${model}")`,
    );
  }
  return {
    model: resolved,
    complete: (context, options) => models.complete(resolved, context, options),
  };
}

/**
 * The reasoning dial OpenAI's Responses API accepts. GPT-6 (like gpt-5.1)
 * supports "none" to disable reasoning entirely; pi-ai's own type omits it
 * because most reasoning models reject it, but it forwards the raw string
 * to the wire unvalidated (`openai-responses.js`'s `reasoningEffort` branch),
 * so passing it through is safe and preserves the old TanStack behavior.
 */
export type OpenAiEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type AnthropicEffort = NonNullable<AnthropicOptions["effort"]>;
export type CompatEffort = NonNullable<
  OpenAICompletionsOptions["reasoningEffort"]
>;

/**
 * The reasoning dial every route accepts — the intersection of the three
 * provider vocabularies, so a value typed this way is valid whichever tier a
 * caller (the eval harness) happens to route it to. OpenAI's `none`/`minimal`
 * and Anthropic's `max` are tier-specific and live on a feature record
 * instead.
 */
export type SharedEffort = OpenAiEffort & AnthropicEffort & CompatEffort;

/**
 * pi-ai's per-API stream options for a forced tool call named `toolName`,
 * with the tier's token cap and reasoning dial mapped onto each provider's
 * own fields. Mirrors the effective parameters the old TanStack adapters
 * sent: OpenAI reasoning effort + an output cap, Anthropic adaptive
 * thinking/effort with no temperature (Haiku 4.5 rejects both — see
 * `adaptiveThinkingFor`), and compat's `reasoning_effort` + token cap.
 */
export function chatCompletionOptionsFor(
  model: SupportedChatModel,
  args: {
    maxTokens: number;
    /** Whichever provider vocabulary `model`'s route takes — the caller's
     * feature record is already tiered to the matching route, so this
     * accepts any of the three rather than only their (narrower) shared
     * intersection. */
    effort?: OpenAiEffort | AnthropicEffort | CompatEffort;
  },
  toolName: string,
): OpenAIResponsesOptions | AnthropicOptions | OpenAICompletionsOptions {
  const config = getChatModelConfig(model);
  switch (config.route) {
    case "openai-responses": {
      const options: OpenAIResponsesOptions = {
        maxTokens: args.maxTokens,
        toolChoice: { type: "function", name: toolName },
      };
      if (args.effort) {
        // SAFETY: pi-ai's `reasoningEffort` type excludes "none"; the
        // provider forwards it verbatim (see `OpenAiEffort`'s comment).
        options.reasoningEffort =
          args.effort as OpenAIResponsesOptions["reasoningEffort"];
      }
      return options;
    }
    case "anthropic": {
      const options: AnthropicOptions = {
        maxTokens: args.maxTokens,
        toolChoice: { type: "tool", name: toolName },
      };
      if (adaptiveThinkingFor(model)) {
        options.thinkingEnabled = true;
        if (args.effort) {
          // SAFETY: `args.effort` is `OpenAiEffort | AnthropicEffort |
          // CompatEffort` (see this function's own comment) because the
          // caller's feature record is already tiered to this route; on the
          // Anthropic route it is always an `AnthropicEffort` value.
          options.effort = args.effort as AnthropicEffort;
        }
      }
      return options;
    }
    case "compat": {
      const options: OpenAICompletionsOptions = {
        maxTokens: args.maxTokens,
        toolChoice: { type: "function", function: { name: toolName } },
      };
      if (args.effort) {
        // SAFETY: as above — on the compat route `args.effort` is always a
        // `CompatEffort` value, since the caller's feature record is already
        // tiered to this route.
        options.reasoningEffort = args.effort as CompatEffort;
      }
      return options;
    }
  }
}
