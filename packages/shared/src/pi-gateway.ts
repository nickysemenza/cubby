import {
  createProvider,
  type Api,
  type Model,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { gatewayBaseURL } from "./ai-gateway-request";

/**
 * Cubby's chat models as pi-ai providers, one per AI Gateway route. Both the
 * web Worker and the purchase agent build their `Models` from this, so a
 * model id, its limits, and its price are declared once. The transport is the
 * caller's: the agent passes its AI-binding `gateway.run` shim, the web Worker
 * its `gatewayFetch`. Every request therefore rides the Gateway; the base URLs
 * are the unroutable placeholders only those shims resolve.
 */
export type GatewayRoute = "openai" | "anthropic";
export type GatewayFetchFor = (route: GatewayRoute) => typeof fetch;

export const OPENAI_MODELS = ["gpt-6-sol", "gpt-6-luna"] as const;
export const ANTHROPIC_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5-5",
  "claude-haiku-4-5",
] as const;
/** Providers SDKs refuse to run without some key; the shims strip it. */
function gatewayAuth(route: GatewayRoute) {
  return {
    apiKey: {
      name: `Cubby ${route} Gateway transport`,
      resolve: async () => ({
        auth: { apiKey: "cf-aig-gateway" },
        source: "Cloudflare AI Gateway",
      }),
    },
  };
}

function throughFetch(
  streams: ProviderStreams,
  fetchFn: typeof fetch,
): ProviderStreams {
  return {
    stream: (model, context, options) =>
      streams.stream(model, context, { ...options, fetch: fetchFn }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, { ...options, fetch: fetchFn }),
  };
}

function catalogModels<TApi extends Api>(
  provider: Provider<TApi>,
  ids: readonly string[],
  baseUrl: string,
): Model<TApi>[] {
  return ids.map((id) => {
    const model = provider.getModels().find((candidate) => candidate.id === id);
    if (!model) throw new Error(`pi-ai does not declare ${id}`);
    return { ...model, baseUrl };
  });
}

export function cubbyPiProviders(fetchFor: GatewayFetchFor): Provider[] {
  return [
    createProvider({
      id: "openai",
      name: "OpenAI through Cubby AI Gateway",
      auth: gatewayAuth("openai"),
      models: catalogModels(
        openaiProvider(),
        OPENAI_MODELS,
        gatewayBaseURL("openai"),
      ),
      api: throughFetch(openAIResponsesApi(), fetchFor("openai")),
    }),
    createProvider({
      id: "anthropic",
      name: "Anthropic through Cubby AI Gateway",
      auth: gatewayAuth("anthropic"),
      models: catalogModels(
        anthropicProvider(),
        ANTHROPIC_MODELS,
        gatewayBaseURL("anthropic"),
      ),
      api: throughFetch(anthropicMessagesApi(), fetchFor("anthropic")),
    }),
  ];
}
