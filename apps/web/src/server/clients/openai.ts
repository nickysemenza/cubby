// Subpath import (not the package root): the root index eagerly loads every
// provider adapter, including gemini, whose `@tanstack/ai-gemini` optionalDep is
// incompatible with our pinned `@tanstack/ai`. See the note in `./anthropic`.
import { createOpenAiChat } from "@cloudflare/tanstack-ai/adapters/openai";
import {
  type GatewayMetadata,
  gatewayAdapterConfig,
} from "~/server/clients/gateway-config";

/**
 * Cheap OpenAI adapter (gpt-4o-mini) routed through Cubby's Cloudflare AI Gateway
 * (binding in prod / REST in dev — see `gatewayAdapterConfig`), for the agentic
 * USDA-matching tool loop. Kept separate from the Anthropic client so it's the
 * only place that knows about the OpenAI provider.
 *
 * API surface: `createOpenAiChat` targets the OpenAI **Responses** API (vs the
 * old `createOpenaiChatCompletions`, which used `/chat/completions`). Verified
 * the multi-turn search->select tool loop in `ai-enrichment.service.ts`
 * (`suggestUsdaFood` / `suggestIngredientMerge`) works through the gateway on
 * this surface.
 */

const MODEL = "gpt-4o-mini";

/**
 * Build a per-call gpt-4o-mini adapter. Not cached as a singleton because the
 * metadata (e.g. the ingredient name) varies per request — and so the prod
 * binding is read fresh per call.
 */
export function getGatewayOpenAIAdapter(metadata?: GatewayMetadata) {
  return createOpenAiChat(MODEL, gatewayAdapterConfig({ metadata }));
}
