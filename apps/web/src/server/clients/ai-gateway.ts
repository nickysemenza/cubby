import { z } from "zod";

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

/** The gateway keeps at most five metadata entries; the rest are dropped. */
const MAX_METADATA_ENTRIES = 5;

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

/**
 * A deterministic, unroutable base URL for provider SDKs. Only
 * {@link gatewayFetch} ever resolves it: the SDK builds
 * `${gatewayBaseURL(p)}/<endpoint>` and the shim turns that back into the
 * gateway's `{provider, endpoint}` pair. `.invalid` is reserved by RFC 2606,
 * so a shim bypass fails loudly instead of leaking a real request.
 */
export function gatewayBaseURL(provider: GatewayProvider): string {
  return `https://ai-gateway.invalid/${provider}`;
}

/**
 * Headers a provider SDK sets that must never reach the gateway. Gateway auth
 * priority is request provider key > BYOK > unified billing, so a placeholder
 * `x-api-key` / `authorization` from the SDK would out-rank unified billing
 * and be sent upstream as a real (bogus) credential. `content-length` is
 * reframed by both branches.
 */
const STRIPPED_SDK_HEADERS = ["authorization", "x-api-key", "content-length"];

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

/** The path (plus search) after the provider's placeholder base. */
function endpointFor(provider: GatewayProvider, url: string): string {
  const prefix = `${gatewayBaseURL(provider)}/`;
  if (url.startsWith(prefix)) return url.slice(prefix.length);
  const parsed = new URL(url);
  return `${parsed.pathname.replace(/^\/+/u, "")}${parsed.search}`;
}

function strippedHeaders(init: RequestInit | undefined): Headers {
  const headers = new Headers(init?.headers);
  for (const name of STRIPPED_SDK_HEADERS) headers.delete(name);
  return headers;
}

function headerRecord(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function cappedMetadata(metadata: GatewayMetadata): GatewayMetadata {
  const entries = Object.entries(metadata);
  if (entries.length <= MAX_METADATA_ENTRIES) return metadata;
  return Object.fromEntries(entries.slice(0, MAX_METADATA_ENTRIES));
}

/** A provider request body: the JSON the gateway forwards as `query`. */
const gatewayQuerySchema = z.record(z.string(), z.json());
type GatewayQuery = z.output<typeof gatewayQuerySchema>;

/**
 * The body a provider SDK sent, decoded. `Response` normalizes every
 * `BodyInit` the SDKs produce (string, typed array, stream) without the shim
 * having to branch on its representation.
 */
async function gatewayQuery(
  body: BodyInit | null | undefined,
): Promise<GatewayQuery> {
  const decoded = await new Response(body ?? "{}")
    .json()
    .catch(() => undefined);
  const parsed = gatewayQuerySchema.safeParse(decoded);
  return parsed.success ? parsed.data : {};
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

    const gateway = getAiGateway();
    if (gateway) {
      return await gateway.run(
        {
          provider,
          endpoint,
          headers: headerRecord(headers),
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
    return await fetch(
      `${GATEWAY_REST_BASE}/${CF_ACCOUNT_ID}/${CF_AIG_GATEWAY_ID}/${provider}/${endpoint}`,
      { ...init, headers, signal },
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
  return getAiGateway() !== undefined || !!env.AI_GATEWAY_API_KEY;
}
