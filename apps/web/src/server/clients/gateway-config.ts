import { env } from "~/env";
import {
  CF_ACCOUNT_ID,
  CF_AIG_GATEWAY_ID,
  getAiGateway,
} from "~/server/cf-env";

/**
 * Up to 5 string/number/boolean entries surfaced in the AI Gateway
 * dashboard/logs for filtering.
 * https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
 */
export type GatewayMetadata = Record<string, string | number | boolean>;

/**
 * Build the binding-or-REST config for a `@cloudflare/tanstack-ai` gateway
 * adapter (`createAnthropicChat` — the only provider in use). Prod
 * authenticates implicitly via the gateway binding; dev (vite Node, no `env.AI`)
 * falls back to gateway-REST with the `AI_GATEWAY_API_KEY` token (`cfApiKey`).
 * The provider `apiKey` is always omitted — the gateway holds it (BYOK/unified
 * billing). Built per call so the per-request prod binding isn't captured stale.
 */
export function gatewayAdapterConfig(opts?: { metadata?: GatewayMetadata }) {
  const gateway = getAiGateway();
  if (gateway) {
    return { binding: gateway, ...opts };
  }
  if (!env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not configured. Add it to your .env file.",
    );
  }
  return {
    accountId: CF_ACCOUNT_ID,
    gatewayId: CF_AIG_GATEWAY_ID,
    cfApiKey: env.AI_GATEWAY_API_KEY,
    ...opts,
  };
}
