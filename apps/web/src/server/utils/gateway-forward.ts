import {
  gatewayForwardInput,
  gatewayForwardOut,
} from "@cubby/schemas/import-recipe";
import { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";
import { recordAiUsage } from "~/server/ai-usage";
import { gatewayAdapterConfig } from "~/server/clients/gateway-config";
import type { Database } from "~/server/db";

const REQUEST_TIMEOUT_MS = 120_000;
const GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1";

type GatewayForwardRequest = z.output<typeof gatewayForwardInput>;
type GatewayForwardResponse = z.output<typeof gatewayForwardOut>;

/** Headers the browser may not set: the server owns identity and framing. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cf-aig-authorization",
  "cf-aig-metadata",
  "content-length",
  "cookie",
  "host",
  "x-api-key",
]);

/** The gateway's cache verdict; `HIT` means the answer was not billed. */
const GATEWAY_CACHE_STATUS = "cf-aig-cache-status";

/**
 * Response headers worth returning: request ids, rate-limit hints, and the
 * cache verdict (the crate books a gateway hit as a free, cached call).
 */
const RETURNED_RESPONSE_HEADERS = new Set([
  GATEWAY_CACHE_STATUS,
  "cf-aig-log-id",
  "cf-ray",
  "content-type",
  "retry-after",
  "x-request-id",
]);

// The `cf-aig-metadata` the crate sends: up to five string/number/boolean
// entries. Only `model` and `purpose` are read here; the rest is passed on.
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

/** The REST gateway coordinates and token, or why they are missing. */
const gatewayRestConfigSchema = z.object({
  accountId: z.string().min(1),
  gatewayId: z.string().min(1),
  cfApiKey: z.string().min(1),
});
type GatewayRestConfig = z.output<typeof gatewayRestConfigSchema>;

/** What a call cost, as the crate prices it. */
const gatewayCallUsageSchema = z.object({
  provider: z.string().min(1),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    cache_read_input_tokens: z.number().int().nonnegative().default(0),
    cache_creation_input_tokens: z.number().int().nonnegative().default(0),
  }),
  cost_usd: z.number().nonnegative().nullable().default(null),
});
type GatewayCallUsage = z.output<typeof gatewayCallUsageSchema>;

type AiUsageRecord = Parameters<typeof recordAiUsage>[1];

/** Everything the forwarder reaches outside itself, so tests can stand it in. */
export interface GatewayForwardPort {
  fetch: typeof fetch;
  /** The REST config, or `null` when only the binding is available. */
  config: () => GatewayRestConfig | null;
  /** Usage and cost from a raw provider body, or `null` when unknown. */
  callUsage: (model: string, body: string) => GatewayCallUsage | null;
  recordUsage: (db: Database, input: AiUsageRecord) => Promise<void>;
}

const productionGatewayForwardPort: GatewayForwardPort = {
  fetch: (input, init) => fetch(input, init),
  config: () => {
    const parsed = gatewayRestConfigSchema.safeParse(gatewayAdapterConfig());
    return parsed.success ? parsed.data : null;
  },
  callUsage: (model, body) => {
    const parsed = gatewayCallUsageSchema.safeParse(
      wasm.gateway_call_usage(model, body),
    );
    return parsed.success ? parsed.data : null;
  },
  recordUsage: recordAiUsage,
};

/** The metadata header, parsed, with `feature` forced to the server's value. */
function metadataWithFeature(
  headers: readonly (readonly [string, string])[],
  feature: string,
) {
  const raw = headers.find(
    ([name]) => name.toLowerCase() === "cf-aig-metadata",
  );
  const parsed = raw ? gatewayMetadataHeader.safeParse(raw[1]) : null;
  const metadata = parsed?.success ? parsed.data : {};
  // The gateway keeps at most five metadata keys; feature is one of them.
  const kept = Object.entries(metadata)
    .filter(([key]) => key !== "feature")
    .slice(0, 4);
  return { ...Object.fromEntries(kept), feature } satisfies z.input<
    typeof gatewayMetadataSchema
  >;
}

/** The outgoing headers: the request's own minus credentials, plus ours. */
function forwardHeaders(
  request: GatewayForwardRequest,
  metadata: z.input<typeof gatewayMetadataSchema>,
  token: string,
): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("cf-aig-metadata", JSON.stringify(metadata));
  headers.set("cf-aig-authorization", `Bearer ${token}`);
  return headers;
}

async function sendWithTimeout(
  port: GatewayForwardPort,
  url: string,
  headers: Headers,
  body: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await port.fetch(url, {
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
 * One AiUsage row for a successful call, priced by the crate. An answer the
 * gateway served from its own cache repeats the provider's usage figures but
 * cost nothing.
 */
function usageRecord(
  feature: string,
  model: string,
  purpose: string | undefined,
  usage: GatewayCallUsage,
  durationMs: number,
  gatewayHit: boolean,
): AiUsageRecord {
  const cacheStatus = gatewayHit
    ? "hit"
    : usage.usage.cache_read_input_tokens > 0
      ? "hit"
      : usage.usage.cache_creation_input_tokens > 0
        ? "miss"
        : "none";
  return {
    feature,
    provider: usage.provider,
    model,
    operation: purpose ? `cookbook.${purpose}` : "cookbook.extract",
    inputTokens: usage.usage.input_tokens,
    outputTokens: usage.usage.output_tokens,
    estimatedCost: gatewayHit ? 0 : usage.cost_usd,
    durationMs,
    cacheStatus,
  };
}

/**
 * Forward one gateway request built by the `cookbook` crate in the browser.
 * The body and provider path pass through untouched; the server strips any
 * client-supplied credentials, adds the gateway token, pins the metadata
 * `feature`, and records usage and cost for the AI-usage ledger. Non-2xx
 * responses are returned as-is so the Rust ladder can react (retry, step
 * down, mark a model exhausted); only a transport failure throws.
 */
export async function forwardGatewayRequest(
  request: GatewayForwardRequest,
  opts: { db?: Database; feature: string },
  port: GatewayForwardPort = productionGatewayForwardPort,
): Promise<GatewayForwardResponse> {
  const config = port.config();
  if (!config) {
    throw new Error(
      "Cookbook extraction needs AI_GATEWAY_API_KEY: the forwarder calls the gateway's REST endpoint.",
    );
  }
  const metadata = metadataWithFeature(request.headers, opts.feature);
  const { model, purpose } = gatewayMetadataKeys.parse(metadata);
  const startedAt = performance.now();
  const response = await sendWithTimeout(
    port,
    `${GATEWAY_BASE}/${config.accountId}/${config.gatewayId}${request.path}`,
    forwardHeaders(request, metadata, config.cfApiKey),
    JSON.stringify(request.body),
  );
  const body = await response.text();
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  const usage =
    opts.db && response.ok && model ? port.callUsage(model, body) : null;
  const gatewayHit =
    response.headers.get(GATEWAY_CACHE_STATUS)?.toUpperCase() === "HIT";
  if (opts.db && model && usage) {
    await port.recordUsage(
      opts.db,
      usageRecord(opts.feature, model, purpose, usage, durationMs, gatewayHit),
    );
  }

  const returned: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (RETURNED_RESPONSE_HEADERS.has(name.toLowerCase()))
      returned.push([name, value]);
  });
  return { status: response.status, headers: returned, body };
}
