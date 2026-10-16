import type { WGatewayCallUsage } from "@cubby/recipebridge";
import type { RunId } from "@cubby/schemas/identifiers";
import {
  gatewayForwardInput,
  gatewayForwardOut,
} from "@cubby/schemas/import-recipe";
import { getErrorMessage } from "@cubby/shared";
import {
  gatewayBaseURL,
  type InferenceFunding,
  type GatewayResponseInfo,
  gatewayResponseInfo,
  isInferenceFundingRefusal,
} from "@cubby/shared/ai/gateway-request";
import { gatewayProviderSchema } from "@cubby/shared/ai/models";
import { createParser } from "eventsource-parser";
import { z } from "zod";

import { type UnparsedError } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";
import { gatewayFetch, type GatewayTransport } from "~/server/ai/gateway";
import { recordAiUsage } from "~/server/ai/usage";
import type { Database } from "~/server/db";

const REQUEST_TIMEOUT_MS = 120_000;

type GatewayForwardRequest = z.output<typeof gatewayForwardInput>;
type GatewayForwardResponse = z.output<typeof gatewayForwardOut>;

/** Headers the browser may not set: the server owns identity and framing. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cf-aig-authorization",
  "cf-aig-metadata",
  "cf-aig-byok-alias",
  "cf-aig-no-wholesale",
  "content-length",
  "cookie",
  "host",
  "x-api-key",
]);

/**
 * Response headers worth returning: request ids, rate-limit hints, and the
 * cache verdict (the crate books a gateway hit as a free, cached call).
 */
const RETURNED_RESPONSE_HEADERS = new Set([
  "cf-aig-cache-status",
  "cf-aig-log-id",
  "cf-ray",
  "content-type",
  "retry-after",
  "x-request-id",
]);

// The `cf-aig-metadata` the crate sends: up to five string/number/boolean
// entries. Only `model` and `purpose` are read, for the usage row; none of it
// is passed on (its cookbook, chunk, and contract tags are per-call values).
const gatewayMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
// The header value: JSON text that must decode to the metadata object.
const gatewayMetadataHeader = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "cf-aig-metadata is not JSON" });
      return z.NEVER;
    }
  })
  .pipe(gatewayMetadataSchema);
const gatewayMetadataKeys = z.object({
  model: z.string().optional(),
  purpose: z.string().optional(),
});

type AiUsageRecord = Parameters<typeof recordAiUsage>[1];

/** Everything the forwarder reaches outside itself, so tests can stand it in. */
export interface GatewayForwardPort {
  /** The shared AI Gateway transport: binding in prod, REST in dev. */
  transport: typeof gatewayFetch;
  /** Provider token counts from a raw provider body; pricing is owned by accounting. */
  callUsage: (model: string, body: string) => WGatewayCallUsage | undefined;
  recordUsage: (db: Database, input: AiUsageRecord) => Promise<void>;
}

const productionGatewayForwardPort: GatewayForwardPort = {
  transport: gatewayFetch,
  callUsage: (model, body) => wasm.gateway_call_usage(model, body),
  recordUsage: recordAiUsage,
};

/** The crate's `model` and `purpose`, read from its metadata header. */
function crateCallTags(headers: readonly (readonly [string, string])[]) {
  const raw = headers.find(
    ([name]) => name.toLowerCase() === "cf-aig-metadata",
  );
  const parsed = raw ? gatewayMetadataHeader.safeParse(raw[1]) : null;
  return gatewayMetadataKeys.parse(parsed?.success ? parsed.data : {});
}

/** The usage ledger's and the gateway's operation for one crate call. */
function cookbookOperation(purpose: string | undefined) {
  return purpose ? `cookbook.${purpose}` : "cookbook.extract";
}

/** The outgoing headers: the request's own minus credentials. */
function forwardHeaders(request: GatewayForwardRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  return headers;
}

/**
 * The crate builds a full provider route (`/anthropic/v1/messages`); the shim
 * addresses the gateway as `{provider, endpoint}`, so split on the first
 * segment. An unrecognized provider is rejected here rather than sent on.
 */
function splitProviderRoute(path: string) {
  const [, segment = "", ...rest] = path.split("/");
  const provider = gatewayProviderSchema.safeParse(segment);
  if (!provider.success) {
    throw new Error(`Unsupported gateway provider route: ${path}`);
  }
  return { provider: provider.data, endpoint: rest.join("/") };
}

async function sendWithTimeout(
  send: typeof fetch,
  url: string,
  headers: Headers,
  body: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await send(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      controller.signal.aborted
        ? `Gateway request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Gateway request failed: ${getErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One AiUsage row for a successful call, priced by the telemetry consumer. The usage
 * writer zeroes a gateway cache hit (the provider's usage figures repeat but
 * were not billed) and a ChatGPT plan answer (plan usage, not API spend).
 * Prompt-cache traffic is token evidence; the forwarder has no cache of its
 * own, so `cacheStatus` is `none`.
 */
function usageRecord(
  feature: string,
  model: string,
  purpose: string | undefined,
  usage: WGatewayCallUsage,
  durationMs: number,
  gateway: GatewayResponseInfo & Pick<AiUsageRecord, "costEvidence">,
  transport: GatewayTransport | "unknown",
  runId: RunId,
): AiUsageRecord {
  return {
    feature,
    provider: usage.provider,
    model,
    operation: cookbookOperation(purpose),
    runId,
    inputTokens: usage.usage.input_tokens,
    outputTokens: usage.usage.output_tokens,
    cacheReadTokens: usage.usage.cache_read_input_tokens,
    cacheWriteTokens: usage.usage.cache_creation_input_tokens,
    durationMs,
    cacheStatus: "none",
    transport,
    ...gateway,
  };
}

const responsesEvent = z.looseObject({
  type: z.string(),
  response: z.looseObject({ error: z.unknown().optional() }).optional(),
  error: z.unknown().optional(),
});
function subscriptionCapacityRefusal(body: string): boolean {
  return isInferenceFundingRefusal(400, body, "subscription");
}

/** The completed response is the exact JSON root the Rust extractor consumes. */
async function foldResponsesStream(response: Response): Promise<Response> {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return response;
  let completed: z.infer<typeof responsesEvent>["response"];
  let failure: unknown;
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === "[DONE]") return;
      const parsed = responsesEvent.parse(JSON.parse(event.data));
      if (parsed.type === "response.completed") completed = parsed.response;
      if (parsed.type === "response.failed")
        failure = parsed.response?.error ?? parsed;
      if (parsed.type === "error") failure = parsed.error ?? parsed;
    },
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Responses stream has no body");
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    parser.feed(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  if (failure !== undefined) {
    const body = JSON.stringify({ error: failure });
    return new Response(body, {
      status: subscriptionCapacityRefusal(body) ? 429 : 502,
      headers,
    });
  }
  if (!completed)
    throw new Error("Responses stream ended without response.completed");
  return new Response(JSON.stringify(completed), {
    status: response.status,
    headers,
  });
}

export async function forwardGatewayRequest(
  request: GatewayForwardRequest,
  opts: { db?: Database; runId?: RunId; feature: string },
  port: GatewayForwardPort = productionGatewayForwardPort,
): Promise<GatewayForwardResponse> {
  const { provider } = splitProviderRoute(request.path);
  const funding =
    provider === "anthropic"
      ? "subscriber_credit"
      : provider === "openai"
        ? "subscription"
        : "paid";
  const response = await forwardGatewayAttempt(request, opts, port, funding);
  if (
    funding === "subscription" &&
    [400, 429].includes(response.status) &&
    subscriptionCapacityRefusal(response.body)
  ) {
    return forwardGatewayAttempt(request, opts, port, "paid");
  }
  return response;
}

/**
 * Forward one gateway request built by the `cookbook` crate in the browser.
 * A failed attempt (thrown or non-2xx) records a failed row on its selected
 * transport.
 * The body and provider path pass through untouched; the server strips any
 * client-supplied credentials, authenticates through the shared gateway
 * transport (Worker binding in prod, REST in dev), labels the call with the
 * server's `feature` and the crate's purpose as `operation`, and records usage and cost for the AI-usage ledger. Non-2xx
 * responses are returned as-is so the Rust ladder can react (retry, step
 * down, mark a model exhausted); only a transport failure throws.
 */
async function forwardGatewayAttempt(
  request: GatewayForwardRequest,
  opts: { db?: Database; runId?: RunId; feature: string },
  port: GatewayForwardPort,
  funding: InferenceFunding,
): Promise<GatewayForwardResponse> {
  const { model, purpose } = crateCallTags(request.headers);
  const operation = cookbookOperation(purpose);
  const { provider, endpoint } = splitProviderRoute(request.path);
  const startedAt = performance.now();
  let transport: GatewayTransport | "unknown" = "unknown";
  const recordFailure = async (failed?: Response) => {
    if (!opts.db || !opts.runId || !model) return;
    await port.recordUsage(opts.db, {
      feature: opts.feature,
      provider,
      model,
      operation,
      runId: opts.runId,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      status: "failed",
      transport,
      ...(failed && gatewayResponseInfo(failed)),
    });
  };
  // Non-2xx responses are still returned for the ladder; only the usage row
  // marks them failed.
  const response = await sendWithTimeout(
    // The crate decides its own caching; only the app-side adapters skip it.
    port.transport(provider, {
      metadata: { feature: opts.feature, operation },
      funding,
      onTransport: (selected) => {
        transport = selected;
      },
    }),
    `${gatewayBaseURL(provider)}/${endpoint}`,
    forwardHeaders(request),
    JSON.stringify(request.body),
  )
    .then((response) =>
      provider === "openai" ? foldResponsesStream(response) : response,
    )
    .catch(async (error: UnparsedError) => {
      await recordFailure();
      throw error;
    });
  if (!response.ok) await recordFailure(response);
  const body = await response.text().catch(async (error: UnparsedError) => {
    // A non-2xx response already has its failed row; a broken success stream
    // has not reported usage yet.
    if (response.ok) await recordFailure(response);
    throw error;
  });
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  const usage =
    opts.db && response.ok && model ? port.callUsage(model, body) : undefined;
  if (opts.db && opts.runId && model && usage) {
    await port.recordUsage(
      opts.db,
      usageRecord(
        opts.feature,
        model,
        purpose,
        usage,
        durationMs,
        {
          ...gatewayResponseInfo(response),
          ...(funding === "subscriber_credit"
            ? {
                costEvidence: {
                  standard: null,
                  charged: null,
                  billingReason: "subscriber_credit" as const,
                },
              }
            : {}),
        },
        transport,
        opts.runId,
      ),
    );
  }

  const returned: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (RETURNED_RESPONSE_HEADERS.has(name.toLowerCase()))
      returned.push([name, value]);
  });
  return { status: response.status, headers: returned, body };
}
