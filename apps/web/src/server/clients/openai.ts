// Subpath import (not the package root): the root index eagerly loads every
// provider adapter, including gemini, whose `@tanstack/ai-gemini` optionalDep is
// incompatible with our pinned `@tanstack/ai`. See the note in `./anthropic`.
import { createOpenAiChat } from "@cloudflare/tanstack-ai/adapters/openai";
import { env } from "~/env";
import {
  CF_ACCOUNT_ID,
  CF_AIG_GATEWAY_ID,
  getAiGateway,
} from "~/server/cf-env";

/**
 * Cheap OpenAI adapter (gpt-4o-mini) routed through Cubby's Cloudflare AI Gateway,
 * for the agentic USDA-matching tool loop. Kept separate from the Anthropic client
 * so it's the only place that knows about the OpenAI provider.
 *
 * Auth: the gateway is authenticated and holds the real OpenAI key (BYOK/unified
 * billing), so we never pass a provider `apiKey`. Prod authenticates implicitly
 * via the gateway binding; dev falls back to gateway-REST with the
 * `AI_GATEWAY_API_KEY` gateway token (`cfApiKey`).
 *
 * API surface: `createOpenAiChat` targets the OpenAI **Responses** API (vs the
 * old `createOpenaiChatCompletions`, which used `/chat/completions`). Verified
 * the multi-turn search->select tool loop in `ai-enrichment.service.ts`
 * (`suggestUsdaFood` / `suggestIngredientMerge`) works through the gateway on
 * this surface.
 */

// CF AI Gateway custom metadata: up to 5 string/number/boolean entries, surfaced
// in the gateway dashboard/logs for filtering. https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
type GatewayMetadata = Record<string, string | number | boolean>;

const MODEL = "gpt-4o-mini";

/**
 * Build a per-call gpt-4o-mini adapter. Not cached as a singleton because the
 * metadata (e.g. the ingredient name) varies per request — and so the prod
 * binding is read fresh per call.
 */
export function getGatewayOpenAIAdapter(metadata?: GatewayMetadata) {
  const gateway = getAiGateway();
  if (gateway) {
    return createOpenAiChat(MODEL, { binding: gateway, metadata });
  }
  if (!env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not configured. Add it to your .env file.",
    );
  }
  return createOpenAiChat(MODEL, {
    accountId: CF_ACCOUNT_ID,
    gatewayId: CF_AIG_GATEWAY_ID,
    cfApiKey: env.AI_GATEWAY_API_KEY,
    metadata,
  });
}
