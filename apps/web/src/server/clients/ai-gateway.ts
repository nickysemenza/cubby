import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  endpointFor,
  gatewayBaseURL,
  gatewayQuery,
  requestUrl,
  strippedHeaders,
} from "@cubby/shared/ai-gateway-request";
import { z } from "zod";

import { env } from "~/env";
import { chatGptInference } from "~/server/ai/chatgpt/client";
import {
  CF_ACCOUNT_ID,
  CF_AIG_GATEWAY_ID,
  getAiGateway,
  getTestAiGateway,
} from "~/server/cf-env";

/**
 * Up to 5 string/number/boolean entries surfaced in the AI Gateway
 * dashboard/logs for filtering.
 * https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
 */
export type GatewayMetadata = Record<string, string | number | boolean>;

export interface GatewayResponseFailure {
  status: number;
  statusText: string;
  body: string;
  retryAfter: string | null;
}

/** The gateway keeps at most five metadata entries; the rest are dropped. */
const MAX_METADATA_ENTRIES = 5;

export { gatewayBaseURL };

const GATEWAY_REST_BASE = "https://gateway.ai.cloudflare.com/v1";

/**
 * The gateway's provider segment — the first path element of a provider route
 * (`/anthropic/v1/messages`, `/openai/responses`, `/compat/chat/completions`).
 * `compat` is not a provider at all but the gateway's unified OpenAI-shaped
 * route, which is how Google AI Studio and Workers AI models are reached.
 */
export const gatewayProviderSchema = z.enum([
  "anthropic",
  "openai",
  "compat",
  "google-ai-studio",
  "workers-ai",
]);
export type GatewayProvider = z.infer<typeof gatewayProviderSchema>;

/**
 * The gateway's own bounds on a cache TTL, in seconds: 60 s (below that it
 * won't cache at all) through 1 month (`GATEWAY_MAX_CACHE_TTL_SECONDS`).
 * https://developers.cloudflare.com/ai-gateway/configuration/caching/
 */
const GATEWAY_MIN_CACHE_TTL_SECONDS = 60;
const GATEWAY_MAX_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Per-call gateway controls; `metadata` is what the dashboard filters on. */
export interface GatewayCallOptions {
  metadata: GatewayMetadata;
  skipCache?: boolean;
  /**
   * Cache this call's response for this many seconds (gateway bounds:
   * {@link GATEWAY_MIN_CACHE_TTL_SECONDS} to
   * {@link GATEWAY_MAX_CACHE_TTL_SECONDS}) — an out-of-range value throws
   * rather than silently clamping, since a caller asking for a week and
   * getting an hour (or a month) is a correctness bug for a deterministic
   * call, not a tolerable approximation. Ignored, like `skipCache`, when the
   * gateway isn't configured to cache this route. Mutually meaningful with
   * `skipCache`: setting both is a caller error the gateway itself doesn't
   * reject, so pick one.
   */
  cacheTtlSeconds?: number;
  requestTimeoutMs?: number;
  /** Preserve a failed HTTP response even if the provider SDK replaces it. */
  onErrorResponse?: (failure: GatewayResponseFailure) => void;
  /**
   * Called before the request leaves with what will carry it: `chatgpt` once
   * the connected plan is selected (its failures never fall back to the
   * gateway), `gateway` otherwise.
   */
  onTransport?: (transport: GatewayTransport) => void;
}

export type GatewayTransport = Extract<AiUsageTransport, "gateway" | "chatgpt">;

async function captureFailure(response: Response, opts: GatewayCallOptions) {
  if (response.ok || !opts.onErrorResponse) return response;
  const reader = response.clone().body?.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let remaining = 4_096;
  if (reader) {
    try {
      while (remaining > 0) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = part.value.subarray(0, remaining);
        body += decoder.decode(bytes, { stream: true });
        remaining -= bytes.length;
      }
      body += decoder.decode();
    } catch (error) {
      body += `[Gateway error body read failed: ${String(error)}]`;
    } finally {
      void reader.cancel().catch(() => {
        // SILENT: clone cleanup must not replace the original HTTP failure.
      });
    }
  }
  opts.onErrorResponse({
    status: response.status,
    statusText: response.statusText,
    body,
    retryAfter: response.headers.get("retry-after"),
  });
  return response;
}

function validatedCacheTtlSeconds(ttl: number | undefined): number | undefined {
  if (ttl === undefined) return undefined;
  if (
    !Number.isInteger(ttl) ||
    ttl < GATEWAY_MIN_CACHE_TTL_SECONDS ||
    ttl > GATEWAY_MAX_CACHE_TTL_SECONDS
  ) {
    throw new Error(
      `cacheTtlSeconds must be an integer between ${GATEWAY_MIN_CACHE_TTL_SECONDS} and ${GATEWAY_MAX_CACHE_TTL_SECONDS}, got ${ttl}`,
    );
  }
  return ttl;
}

function cappedMetadata(metadata: GatewayMetadata): GatewayMetadata {
  const entries = Object.entries(metadata);
  if (entries.length <= MAX_METADATA_ENTRIES) return metadata;
  return Object.fromEntries(entries.slice(0, MAX_METADATA_ENTRIES));
}

/**
 * The one AI Gateway transport: a `fetch` any provider SDK can be handed.
 *
 * In prod the Worker's `env.AI.gateway("cubby")` binding carries the request
 * over the Universal endpoint, so the Worker's own identity authenticates and
 * unified billing / BYOK apply — no token in the request at all. The dev Node
 * server has no binding (`setCfEnv` only runs in `cf-server.ts`), so it falls
 * back to the gateway's REST endpoint with `AI_GATEWAY_API_KEY`.
 *
 * Both branches return the gateway's `Response` untouched, so streaming bodies
 * pass straight through to the SDK.
 */
export function gatewayFetch(
  provider: GatewayProvider,
  opts: GatewayCallOptions,
): typeof fetch {
  const metadata = cappedMetadata(opts.metadata);
  const cacheTtlSeconds = validatedCacheTtlSeconds(opts.cacheTtlSeconds);
  return async (input, init) => {
    const endpoint = endpointFor(provider, requestUrl(input));
    const headers = strippedHeaders(init);
    const signal = init?.signal ?? undefined;

    const testGateway = getTestAiGateway();
    if (testGateway) {
      // The test binding stands in for the gateway.
      opts.onTransport?.("gateway");
      headers.set("cf-aig-metadata", JSON.stringify(metadata));
      // Only the wire fields cross the test service binding: a provider SDK's
      // init carries extra properties (and its own AbortSignal) that a
      // binding cannot clone.
      return captureFailure(
        await testGateway.fetch(
          `https://ai-gateway.test/${provider}/${endpoint}`,
          { method: init?.method ?? "POST", headers, body: init?.body },
        ),
        opts,
      );
    }

    if (provider === "openai" && endpoint === "responses") {
      const subscription = await chatGptInference(
        await gatewayQuery(init?.body),
        {
          signal,
          requestTimeoutMs: opts.requestTimeoutMs,
          onSelected: () => opts.onTransport?.("chatgpt"),
        },
      );
      if (subscription) return captureFailure(subscription, opts);
    }
    opts.onTransport?.("gateway");

    const gateway = getAiGateway();
    if (gateway) {
      return captureFailure(
        await gateway.run(
          {
            provider,
            endpoint,
            headers: Object.fromEntries(headers.entries()),
            query: await gatewayQuery(init?.body),
          },
          {
            gateway: {
              skipCache: opts.skipCache,
              cacheTtl: cacheTtlSeconds,
              metadata,
              requestTimeoutMs: opts.requestTimeoutMs,
            },
            signal,
          },
        ),
        opts,
      );
    }

    if (!env.AI_GATEWAY_API_KEY) {
      throw new Error(
        "AI_GATEWAY_API_KEY is not configured. Add it to your .env file.",
      );
    }
    headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_API_KEY}`);
    headers.set("cf-aig-metadata", JSON.stringify(metadata));
    if (opts.skipCache) headers.set("cf-aig-skip-cache", "true");
    if (cacheTtlSeconds !== undefined) {
      headers.set("cf-aig-cache-ttl", String(cacheTtlSeconds));
    }
    if (opts.requestTimeoutMs !== undefined) {
      headers.set("cf-aig-request-timeout", String(opts.requestTimeoutMs));
    }
    return captureFailure(
      await fetch(
        `${GATEWAY_REST_BASE}/${CF_ACCOUNT_ID}/${CF_AIG_GATEWAY_ID}/${provider}/${endpoint}`,
        { ...init, headers, signal },
      ),
      opts,
    );
  };
}

/**
 * Whether {@link gatewayFetch} can reach the gateway at all.
 *
 * The same branch decision, asked ahead of time: the binding authenticates
 * itself, and only the REST fallback needs `AI_GATEWAY_API_KEY`. Callers that
 * degrade instead of failing (semantic search hides itself when embeddings are
 * unavailable) ask here rather than re-deriving the rule, which is how the old
 * embeddings client came to treat a bindingless prod Worker as unconfigured.
 */
export function gatewayConfigured(): boolean {
  return (
    getTestAiGateway() !== undefined ||
    getAiGateway() !== undefined ||
    !!env.AI_GATEWAY_API_KEY
  );
}
