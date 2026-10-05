import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  type AiGatewayCallMetadata,
  type AiGatewayEnvironment,
  type AiGatewayMetadata,
  aiGatewayEnvironment,
  aiGatewayMetadataSchema,
  CUBBY_AI_GATEWAY_ID,
} from "@cubby/shared/ai-gateway-metadata";
import {
  endpointFor,
  gatewayBaseURL,
  gatewayQuery,
  requestUrl,
  strippedHeaders,
  type WorkersAiRunGateway,
  workersAiModel,
  workersAiRunRequest,
} from "@cubby/shared/ai-gateway-request";
import { z } from "zod";

import { env } from "~/env";
import { chatGptInference } from "~/server/ai/chatgpt/client";
import {
  CF_ACCOUNT_ID,
  getAi,
  getAiGateway,
  getTestAiGateway,
} from "~/server/cf-env";

/**
 * A call's gateway labels (`feature`, `operation`, optional `entityKind`);
 * {@link gatewayFetch} adds `environment`. See `aiGatewayMetadataSchema`.
 * https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
 */
export type GatewayMetadata = AiGatewayCallMetadata;

export interface GatewayResponseFailure {
  status: number;
  statusText: string;
  body: string;
  retryAfter: string | null;
}

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

const callMetadataSchema = aiGatewayMetadataSchema.omit({ environment: true });

/**
 * The caller's labels, validated, plus the runtime's environment. A caller
 * that passes any other key (or its own `environment`) throws here rather
 * than having it truncated or forwarded.
 */
function outboundMetadata(metadata: GatewayMetadata): AiGatewayMetadata {
  return aiGatewayMetadataSchema.parse({
    ...callMetadataSchema.parse(metadata),
    environment: gatewayEnvironment(),
  });
}

/** This runtime's `environment` label, from runtime variables only. */
export function gatewayEnvironment(): AiGatewayEnvironment {
  return aiGatewayEnvironment({
    NODE_ENV: env.NODE_ENV,
    E2E_AUTH_TEST_MODE: env.E2E_AUTH_TEST_MODE,
    CI: process.env.CI,
  });
}

function requiredApiKey(): string {
  if (!env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not configured. Add it to your .env file.",
    );
  }
  return env.AI_GATEWAY_API_KEY;
}

/**
 * A Workers AI model call, scoped to the gateway: `AI.run` with `gateway.id`
 * on the binding (it posts to the binding's gateway-scoped run endpoint,
 * workerd `ai-api.ts`), else the REST twin. Never Universal `gateway.run` or
 * the gateway's provider route, which the account's `default` gateway logs a
 * second time (see `workersAiRunRequest`).
 */
async function workersAiFetch(
  endpoint: string,
  body: BodyInit | null | undefined,
  gateway: WorkersAiRunGateway,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const model = workersAiModel(endpoint);
  const input = await gatewayQuery(body);
  const ai = getAi();
  if (!ai) {
    const run = workersAiRunRequest({
      accountId: CF_ACCOUNT_ID,
      token: requiredApiKey(),
      model,
      input,
      gateway,
      signal,
    });
    return fetch(run.url, run.init);
  }
  const response = await ai.run(model, input, {
    gateway,
    returnRawResponse: true,
    signal,
  });
  // `returnRawResponse` resolves to the HTTP Response; the unknown-model
  // overload's declared return type does not model that option.
  if (response instanceof Response) return response;
  throw new Error(`Workers AI binding returned no raw Response for ${model}`);
}

/**
 * The one AI Gateway transport: a `fetch` any provider SDK can be handed.
 *
 * In prod the Worker's `env.AI` binding carries the request — Workers AI
 * models through `AI.run` scoped to the `cubby` gateway, every other provider
 * over `env.AI.gateway("cubby")`'s Universal endpoint — so the Worker's own
 * identity authenticates and unified billing / BYOK apply, with no token in
 * the request. A Node process without the binding falls back to REST with
 * `AI_GATEWAY_API_KEY`: the gateway's provider route, or the account
 * `/ai/run` for Workers AI.
 *
 * Every branch returns the gateway's `Response` untouched, so streaming bodies
 * pass straight through to the SDK.
 */
export function gatewayFetch(
  provider: GatewayProvider,
  opts: GatewayCallOptions,
): typeof fetch {
  const metadata = outboundMetadata(opts.metadata);
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
    const gatewayOptions = {
      skipCache: opts.skipCache,
      cacheTtl: cacheTtlSeconds,
      metadata,
      requestTimeoutMs: opts.requestTimeoutMs,
    };

    if (provider === "workers-ai") {
      return captureFailure(
        await workersAiFetch(
          endpoint,
          init?.body,
          { id: CUBBY_AI_GATEWAY_ID, ...gatewayOptions },
          signal,
        ),
        opts,
      );
    }

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
          { gateway: gatewayOptions, signal },
        ),
        opts,
      );
    }

    headers.set("cf-aig-authorization", `Bearer ${requiredApiKey()}`);
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
        `${GATEWAY_REST_BASE}/${CF_ACCOUNT_ID}/${CUBBY_AI_GATEWAY_ID}/${provider}/${endpoint}`,
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
