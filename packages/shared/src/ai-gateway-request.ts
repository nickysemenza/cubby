import { z } from "zod";

import type { AiGatewayMetadata } from "./ai-gateway-metadata";

/**
 * Pure request-shaping helpers shared by every AI Gateway `fetch` shim (web
 * and purchase-agent). No Cloudflare types: each shim owns its own transport.
 */

/**
 * A deterministic, unroutable base URL for provider SDKs. Only a gateway fetch
 * shim ever resolves it: the SDK builds `${gatewayBaseURL(p)}/<endpoint>` and
 * the shim turns that back into the gateway's `{provider, endpoint}` pair.
 * `.invalid` is reserved by RFC 2606, so a shim bypass fails loudly instead of
 * leaking a real request.
 */
export function gatewayBaseURL(provider: string): string {
  return `https://ai-gateway.invalid/${provider}`;
}

/**
 * Headers a provider SDK sets that must never reach the gateway. Gateway auth
 * priority is request provider key > BYOK > unified billing, so a placeholder
 * `x-api-key` / `authorization` from the SDK would out-rank unified billing
 * and be sent upstream as a real (bogus) credential. `content-length` is
 * reframed by every branch.
 */
const STRIPPED_SDK_HEADERS = [
  "authorization",
  "x-api-key",
  "content-length",
] as const;

export function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

/** The path (plus search) after the provider's placeholder base. */
export function endpointFor(provider: string, url: string): string {
  const prefix = `${gatewayBaseURL(provider)}/`;
  if (url.startsWith(prefix)) return url.slice(prefix.length);
  const parsed = new URL(url);
  return `${parsed.pathname.replace(/^\/+/u, "")}${parsed.search}`;
}

export function strippedHeaders(init: RequestInit | undefined): Headers {
  const headers = new Headers(init?.headers);
  for (const name of STRIPPED_SDK_HEADERS) headers.delete(name);
  return headers;
}

/** A provider request body: the JSON the gateway forwards as `query`. */
const gatewayQuerySchema = z.record(z.string(), z.json());
type GatewayQuery = z.output<typeof gatewayQuerySchema>;

/**
 * The body a provider SDK sent, decoded. `Response` normalizes every
 * `BodyInit` the SDKs produce (string, typed array, stream) without the shim
 * having to branch on its representation.
 */
export async function gatewayQuery(
  body: BodyInit | null | undefined,
): Promise<GatewayQuery> {
  const decoded = await new Response(body ?? "{}")
    .json()
    .catch(() => undefined);
  const parsed = gatewayQuerySchema.safeParse(decoded);
  return parsed.success ? parsed.data : {};
}

/** The model a `${gatewayBaseURL("workers-ai")}/run/<model>` call names. */
export function workersAiModel(endpoint: string): string {
  const model = /^run\/(.+)$/u.exec(endpoint)?.[1];
  if (!model) throw new Error(`Unsupported Workers AI endpoint: ${endpoint}`);
  return model;
}

/** The binding's `GatewayOptions`, as the REST run body carries them. */
export interface WorkersAiRunGateway {
  id: string;
  metadata: AiGatewayMetadata;
  skipCache?: boolean;
  cacheTtl?: number;
  requestTimeoutMs?: number;
}

/**
 * A Workers AI model call over the account REST `/ai/run`, scoped to a
 * gateway in its own body — the REST twin of the binding's
 * `AI.run(model, input, { gateway })`.
 *
 * Regression: the gateway's provider route
 * (`gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/run/<model>`)
 * and Universal `gateway.run({provider: "workers-ai"})` forwarded the model
 * call unscoped, so the account's `default` gateway logged every call a
 * second time with no metadata and recreated itself after deletion. A
 * `cf-aig-gateway-id` header on those routes did not prevent it.
 */
export function workersAiRunRequest(args: {
  accountId: string;
  token: string;
  model: string;
  input: unknown;
  gateway: WorkersAiRunGateway;
  signal?: AbortSignal;
}) {
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${args.accountId}/ai/run`,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        input: args.input,
        options: { gateway: args.gateway },
      }),
      signal: args.signal,
    } satisfies RequestInit,
  };
}
