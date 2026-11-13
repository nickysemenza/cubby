import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  type AiGatewayCallMetadata,
  type AiGatewayEnvironment,
  type AiGatewayMetadata,
  aiGatewayEnvironment,
  aiGatewayMetadataSchema,
  aiGatewayId,
  CUBBY_AI_GATEWAY_ID,
} from "@cubby/shared/ai/gateway-metadata";
import {
  type GatewayControls,
  type GatewayFetchRoutes,
  gatewayFetchThrough,
  type GatewayResponseObservers,
} from "@cubby/shared/ai/gateway-request";
import type { GatewayProvider } from "@cubby/shared/ai/models";

import { env } from "~/env";
import { chatGptInference } from "~/server/ai/chatgpt/client";
import { getTestAiGateway, getAiGatewayEgress } from "~/server/cf-env";
import {
  markTransmitted,
  refusedBeforeSending,
} from "~/server/kernel/produce-ledger";
import { WorkDeferredError } from "~/server/kernel/work-errors";

import { AiWorkDeferredError } from "./cooperative-work";
import {
  coordinatedGatewayRequest,
  GatewayAdmissionWaitError,
  gatewayProviderStop,
} from "./gateway-egress-client";

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
export interface GatewayCallOptions
  extends
    GatewayResponseObservers,
    Pick<
      GatewayFetchRoutes,
      | "subscriptionRequired"
      | "subscriptionFallback"
      | "beforePaidRequest"
      | "beforePlanRequest"
      | "funding"
      | "flex"
    > {
  metadata: GatewayMetadata;
  collectPayload?: boolean;
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

/** A pre-request admission refusal sent nothing; the Ask that waits on it re-queues. */
async function admission<T>(admit: () => Promise<T>): Promise<T> {
  try {
    return await admit();
  } catch (error) {
    throw refusedBeforeSending(error);
  }
}

/**
 * A classified funding or configuration stop is the provider refusing the
 * request without paid work; every other response may have been billed.
 */
async function received(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response
      .clone()
      .text()
      .catch(() => "");
    const stop = gatewayProviderStop(response.status, body);
    if (stop) {
      refusedBeforeSending(stop);
      return response;
    }
  }
  markTransmitted();
  return response;
}

/** The egress object's shared-capacity wait refuses before the provider sees the request. */
function egressAdmissionWait(error: unknown): WorkDeferredError | null {
  const until =
    error instanceof GatewayAdmissionWaitError
      ? error.retryAt
      : error instanceof AiWorkDeferredError
        ? error.until
        : null;
  return until === null
    ? null
    : new WorkDeferredError(
        "AI Gateway admission is waiting for shared capacity",
        new Date(until),
        "provider_capacity",
      );
}

/**
 * The one AI Gateway transport: a `fetch` any provider SDK can be handed.
 *
 * Every request goes through the coordinated egress Durable Object, which
 * runs Workers AI models with `AI.run` scoped to the `cubby` gateway. Credit
 * uses native passthrough with its named alias and no-wholesale control.
 * Paid OpenAI/Anthropic chat uses Unified Billing `/ai/v1` and paid OpenAI
 * embeddings `/ai/run`, both with explicit Cloudflare catalog ids. Other
 * provider protocols retain native routing.
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
    collectPayload: opts.collectPayload,
  };
  return gatewayFetchThrough({
    provider,
    funding: opts.funding,
    onResponse: opts.onResponse,
    onErrorResponse: opts.onErrorResponse,
    onRecoveredErrorResponse: opts.onRecoveredErrorResponse,
    onTransport: opts.onTransport,
    requestTimeoutMs: opts.requestTimeoutMs,
    chatGpt: (body, options) =>
      chatGptInference(body, {
        ...options,
        onSelected: () => {
          markTransmitted();
          options?.onSelected?.();
        },
      }),
    subscriptionRequired: opts.subscriptionRequired,
    subscriptionFallback: opts.subscriptionFallback,
    flex: opts.flex,
    beforePaidRequest: (request) =>
      admission(async () => {
        await (
          await import("~/server/workflows/runs/execution")
        ).assertWorkflowCurrent();
        await opts.beforePaidRequest?.(request);
      }),
    beforePlanRequest: (request) =>
      admission(async () => {
        await (
          await import("~/server/workflows/runs/execution")
        ).assertWorkflowCurrent();
        return (await opts.beforePlanRequest?.(request)) ?? null;
      }),
    // Credits have no budget, but a workflow that lost its Job still must not
    // transmit on them.
    beforeCreditRequest: () =>
      admission(async () => {
        await (
          await import("~/server/workflows/runs/execution")
        ).assertWorkflowCurrent();
      }),
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
        return testGateway
          .fetch(`https://ai-gateway.test/${provider}/${request.endpoint}`, {
            method: request.init?.method ?? "POST",
            headers: request.headers,
            body: request.init?.body,
          })
          .then(received, (error: unknown) => {
            markTransmitted();
            throw error;
          });
      };
    },
    // Every runtime binds the egress object; it owns admission and holds.
    gateway: async (request) => {
      const egress = getAiGatewayEgress(
        aiGatewayId(controls.metadata.environment),
      );
      if (!egress)
        throw new Error("AI Gateway requires the AI_GATEWAY_EGRESS binding");
      let response: Response;
      try {
        response = await coordinatedGatewayRequest(
          egress,
          provider,
          request,
          controls,
        );
      } catch (error) {
        const wait = egressAdmissionWait(error);
        if (wait) throw refusedBeforeSending(error, wait);
        markTransmitted();
        throw error;
      }
      return received(response);
    },
  });
}

/**
 * Whether {@link gatewayFetch} can reach the gateway at all: a test peer or
 * the egress binding every Worker runtime has. Callers that degrade instead
 * of failing (semantic search hides itself when embeddings are unavailable)
 * ask here rather than re-deriving the rule.
 */
export function gatewayConfigured(): boolean {
  return (
    getTestAiGateway() !== undefined ||
    getAiGatewayEgress(CUBBY_AI_GATEWAY_ID) !== undefined
  );
}
