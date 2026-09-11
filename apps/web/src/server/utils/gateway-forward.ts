import type { z } from "zod";
import {
  gatewayForwardInput,
  gatewayForwardOut,
} from "@cubby/schemas/import-recipe";

import { wasm } from "~/lib/wasm";
import { getErrorMessage } from "~/lib/error-utils";
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
  "content-length",
  "cookie",
  "host",
  "x-api-key",
]);

/** Response headers worth returning: request ids and rate-limit hints. */
const RETURNED_RESPONSE_HEADERS = new Set([
  "cf-aig-log-id",
  "cf-ray",
  "content-type",
  "retry-after",
  "x-request-id",
]);

export interface GatewayForwardPort {
  fetch: typeof fetch;
}

const productionGatewayForwardPort: GatewayForwardPort = {
  fetch: (input, init) => fetch(input, init),
};

/** The `cf-aig-metadata` header, with `feature` forced to the server's value. */
function metadataWithFeature(
  headers: readonly (readonly [string, string])[],
  feature: string,
): Record<string, string | number | boolean> {
  const raw = headers.find(([name]) => name.toLowerCase() === "cf-aig-metadata");
  let parsed: Record<string, string | number | boolean> = {};
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw[1]);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, entry] of Object.entries(value)) {
          if (
            typeof entry === "string" ||
            typeof entry === "number" ||
            typeof entry === "boolean"
          )
            parsed[key] = entry;
        }
      }
    } catch {
      parsed = {};
    }
  }
  // The gateway keeps at most five metadata keys; feature is one of them.
  const kept = Object.entries(parsed)
    .filter(([key]) => key !== "feature")
    .slice(0, 4);
  return { ...Object.fromEntries(kept), feature };
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
  const config = gatewayAdapterConfig();
  if (!("cfApiKey" in config)) {
    throw new Error(
      "Cookbook extraction needs AI_GATEWAY_API_KEY: the gateway binding cannot forward arbitrary provider routes.",
    );
  }
  const metadata = metadataWithFeature(request.headers, opts.feature);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(key) || key === "cf-aig-metadata") continue;
    headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("cf-aig-metadata", JSON.stringify(metadata));
  headers.set("cf-aig-authorization", `Bearer ${config.cfApiKey}`);

  const model = typeof metadata.model === "string" ? metadata.model : "";
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await port.fetch(
      `${GATEWAY_BASE}/${config.accountId}/${config.gatewayId}${request.path}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      },
    );
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
  const body = await response.text();
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (opts.db && response.ok && model) {
    const usage = wasm.gateway_call_usage(model, body);
    if (usage) {
      await recordAiUsage(opts.db, {
        feature: opts.feature,
        provider: usage.provider,
        model,
        operation:
          typeof metadata.purpose === "string"
            ? `cookbook.${metadata.purpose}`
            : "cookbook.extract",
        inputTokens: usage.usage.input_tokens ?? 0,
        outputTokens: usage.usage.output_tokens ?? 0,
        estimatedCost: usage.cost_usd ?? null,
        durationMs,
        cacheStatus:
          (usage.usage.cache_read_input_tokens ?? 0) > 0
            ? "hit"
            : (usage.usage.cache_creation_input_tokens ?? 0) > 0
              ? "miss"
              : "none",
      });
    }
  }

  const returned: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (RETURNED_RESPONSE_HEADERS.has(name.toLowerCase()))
      returned.push([name, value]);
  });
  return { status: response.status, headers: returned, body };
}
