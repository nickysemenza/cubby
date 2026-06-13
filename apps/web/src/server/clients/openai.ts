import { createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { env } from "~/env";
import { AI_GATEWAY_BASE_URL } from "./anthropic";

/**
 * Cheap OpenAI adapter (gpt-4o-mini) routed through Cubby's Cloudflare AI Gateway,
 * for the agentic USDA-matching tool loop. Kept separate from the Anthropic client
 * so it's the only place that knows about the OpenAI provider.
 *
 * Auth mirrors the cookbook proxy (`server/utils/cookbook-llm.ts`): the gateway is
 * in authenticated/unified mode, so the bearer goes in `cf-aig-authorization` and
 * the gateway supplies the real OpenAI key (BYOK). `AI_GATEWAY_API_KEY` is a
 * gateway token, not a provider key.
 *
 * We target the Chat Completions endpoint (`createOpenaiChatCompletions` →
 * `${baseURL}/chat/completions`) — the same surface the cookbook Gemini path uses —
 * rather than the Responses API, for broad gateway + tool-calling compatibility.
 */

// CF AI Gateway custom metadata: up to 5 string/number/boolean entries, surfaced
// in the gateway dashboard/logs for filtering. https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
type GatewayMetadata = Record<string, string | number | boolean>;

const MODEL = "gpt-4o-mini";

/**
 * Build a per-call gpt-4o-mini adapter. Not cached as a singleton because the
 * metadata (e.g. the ingredient name) varies per request.
 */
export function getGatewayOpenAIAdapter(metadata?: GatewayMetadata) {
  if (!env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not configured. Add it to your .env file.",
    );
  }
  const token = env.AI_GATEWAY_API_KEY;

  // The gateway uses unified auth: it injects the stored provider key when the
  // request carries `cf-aig-authorization` and NO provider `Authorization` header
  // (mirrors `cookbook-llm.ts`). The OpenAI SDK always sets `Authorization` from
  // its apiKey, so we strip it in a custom fetch and add the gateway headers there.
  const gatewayFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.set("cf-aig-authorization", `Bearer ${token}`);
    if (metadata) headers.set("cf-aig-metadata", JSON.stringify(metadata));
    return fetch(input, { ...init, headers });
  };

  return createOpenaiChatCompletions(MODEL, token, {
    baseURL: `${AI_GATEWAY_BASE_URL}/openai`,
    fetch: gatewayFetch,
  });
}
