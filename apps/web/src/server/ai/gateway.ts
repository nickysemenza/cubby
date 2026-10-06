import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  type AiGatewayCallMetadata,
  type AiGatewayEnvironment,
  type AiGatewayMetadata,
  aiGatewayEnvironment,
  aiGatewayMetadataSchema,
  CF_ACCOUNT_ID,
  CUBBY_AI_GATEWAY_ID,
} from "@cubby/shared/ai/gateway-metadata";
import {
  type GatewayControls,
  type GatewayFetchRequest,
  gatewayControlHeaders,
  gatewayFetchThrough,
  gatewayProviderUrl,
  type GatewayResponseObservers,
  runUniversalGateway,
  type WorkersAiRunGateway,
  workersAiModel,
  workersAiRunRequest,
} from "@cubby/shared/ai/gateway-request";
import type { GatewayProvider } from "@cubby/shared/ai/models";

import { env } from "~/env";
import { chatGptInference } from "~/server/ai/chatgpt/client";
import { getAi, getAiGateway, getTestAiGateway } from "~/server/cf-env";

/**
 * A call's gateway labels (`feature`, `operation`, optional `entityKind`);
 * {@link gatewayFetch} adds `environment`. See `aiGatewayMetadataSchema`.
 * https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
 */
export type GatewayMetadata = AiGatewayCallMetadata;

/**
 * The gateway's own bounds on a cache TTL, in seconds: 60 s (below that it
 * won't cache at all) through 1 month (`GATEWAY_MAX_CACHE_TTL_SECONDS`).
 * https://developers.cloudflare.com/ai-gateway/configuration/caching/
 */
const GATEWAY_MIN_CACHE_TTL_SECONDS = 60;
const GATEWAY_MAX_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Per-call gateway controls; `metadata` is what the dashboard filters on. */
export interface GatewayCallOptions extends GatewayResponseObservers {
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
  /**
   * Called before the request leaves with what will carry it: `chatgpt` once
   * the connected plan is selected (its failures never fall back to the
   * gateway), `gateway` otherwise.
   */
  onTransport?: (transport: GatewayTransport) => void;
}

export type GatewayTransport = Extract<AiUsageTransport, "gateway" | "chatgpt">;

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
  request: GatewayFetchRequest,
  gateway: WorkersAiRunGateway,
): Promise<Response> {
  const { signal } = request;
  const model = workersAiModel(request.endpoint);
  const input = await request.query();
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
  const controls: GatewayControls = {
    skipCache: opts.skipCache,
    cacheTtl: validatedCacheTtlSeconds(opts.cacheTtlSeconds),
    metadata: outboundMetadata(opts.metadata),
    requestTimeoutMs: opts.requestTimeoutMs,
  };
  return gatewayFetchThrough({
    provider,
    onResponse: opts.onResponse,
    onErrorResponse: opts.onErrorResponse,
    onTransport: opts.onTransport,
    requestTimeoutMs: opts.requestTimeoutMs,
    chatGpt: chatGptInference,
    testPeer: () => {
      const testGateway = getTestAiGateway();
      if (!testGateway) return undefined;
      // Only the wire fields cross the test service binding: a provider SDK's
      // init carries extra properties (and its own AbortSignal) that a
      // binding cannot clone.
      return (request) => {
        request.headers.set(
          "cf-aig-metadata",
          JSON.stringify(controls.metadata),
        );
        return testGateway.fetch(
          `https://ai-gateway.test/${provider}/${request.endpoint}`,
          {
            method: request.init?.method ?? "POST",
            headers: request.headers,
            body: request.init?.body,
          },
        );
      };
    },
    gateway: async (request) => {
      if (provider === "workers-ai")
        return workersAiFetch(request, {
          id: CUBBY_AI_GATEWAY_ID,
          ...controls,
        });
      const gateway = getAiGateway();
      if (gateway)
        return runUniversalGateway(gateway, provider, request, controls);
      const headers = request.headers;
      headers.set("cf-aig-authorization", `Bearer ${requiredApiKey()}`);
      for (const [name, value] of Object.entries(
        gatewayControlHeaders(controls),
      ))
        headers.set(name, value);
      return fetch(
        gatewayProviderUrl({
          accountId: CF_ACCOUNT_ID,
          gatewayId: CUBBY_AI_GATEWAY_ID,
          provider,
          endpoint: request.endpoint,
        }),
        { ...request.init, headers, signal: request.signal },
      );
    },
  });
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
