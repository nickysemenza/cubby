import { z } from "zod";

import type { AiGatewayMetadata } from "./gateway-metadata";

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
function endpointFor(provider: string, url: string): string {
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
export type GatewayQuery = z.output<typeof gatewayQuerySchema>;

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

/** The model a `${gatewayBaseURL("workers-ai")}/run/<model>` call names. */
export function workersAiModel(endpoint: string): string {
  const model = /^run\/(.+)$/u.exec(endpoint)?.[1];
  if (!model) throw new Error(`Unsupported Workers AI endpoint: ${endpoint}`);
  return model;
}

/**
 * Per-call gateway controls: the binding takes them as `gateway` options, the
 * REST routes as the documented `cf-aig-*` headers ({@link gatewayControlHeaders}).
 */
export interface GatewayControls {
  metadata: AiGatewayMetadata;
  skipCache?: boolean;
  cacheTtl?: number;
  requestTimeoutMs?: number;
}

/** {@link GatewayControls} scoped to one gateway, as `AI.run` takes them. */
export interface WorkersAiRunGateway extends GatewayControls {
  id: string;
}

/** The documented `cf-aig-*` headers; each control's header is sent only when set. */
export interface GatewayControlHeaders {
  "cf-aig-metadata": string;
  "cf-aig-skip-cache"?: string;
  "cf-aig-cache-ttl"?: string;
  "cf-aig-request-timeout"?: string;
}

/** The documented `cf-aig-*` headers for the controls a caller chose. */
export function gatewayControlHeaders(
  controls: GatewayControls,
): GatewayControlHeaders {
  const headers: GatewayControlHeaders = {
    "cf-aig-metadata": JSON.stringify(controls.metadata),
  };
  if (controls.skipCache !== undefined)
    headers["cf-aig-skip-cache"] = String(controls.skipCache);
  if (controls.cacheTtl !== undefined)
    headers["cf-aig-cache-ttl"] = String(controls.cacheTtl);
  if (controls.requestTimeoutMs !== undefined)
    headers["cf-aig-request-timeout"] = String(controls.requestTimeoutMs);
  return headers;
}

const GATEWAY_REST_BASE = "https://gateway.ai.cloudflare.com/v1";

/** A provider route on the gateway's REST endpoint. */
export function gatewayProviderUrl(args: {
  accountId: string;
  gatewayId: string;
  provider: string;
  endpoint: string;
}): string {
  return `${GATEWAY_REST_BASE}/${args.accountId}/${args.gatewayId}/${args.provider}/${args.endpoint}`;
}

export function workersAiRunRequest(args: {
  accountId: string;
  token: string;
  model: string;
  input: unknown;
  gateway: WorkersAiRunGateway;
  signal?: AbortSignal;
}) {
  const headers = new Headers({
    authorization: `Bearer ${args.token}`,
    "content-type": "application/json",
    "cf-aig-gateway-id": args.gateway.id,
    ...gatewayControlHeaders(args.gateway),
  });
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${args.accountId}/ai/run`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: args.model,
        input: args.input,
      }),
      signal: args.signal,
    } satisfies RequestInit,
  };
}

/** What a received gateway response says about itself, for usage accounting. */
export interface GatewayResponseInfo {
  /** `cf-aig-log-id`: the gateway log this call correlates with. */
  gatewayLogId: string | null;
  /** `cf-aig-cache-status`: whether the gateway replayed a cached answer. */
  gatewayCacheStatus: "hit" | "miss" | null;
}

const gatewayCacheStatusSchema = z
  .string()
  .transform((status) => status.toLowerCase())
  .pipe(z.enum(["hit", "miss"]));

/** Reads only headers, so the provider SDK still gets the whole body. */
export function gatewayResponseInfo(response: Response): GatewayResponseInfo {
  return {
    gatewayLogId: response.headers.get("cf-aig-log-id"),
    gatewayCacheStatus:
      gatewayCacheStatusSchema.safeParse(
        response.headers.get("cf-aig-cache-status"),
      ).data ?? null,
  };
}

/** A failed HTTP response's raw diagnostics, before an SDK replaces it. */
export interface GatewayResponseFailure {
  status: number;
  statusText: string;
  body: string;
  retryAfter: string | null;
}

/** Observers every transport branch reports each received response to. */
export interface GatewayResponseObservers {
  /** Every received response, without consuming its body. */
  onResponse?: (info: GatewayResponseInfo) => void;
  /** Preserve a failed HTTP response even if the provider SDK replaces it. */
  onErrorResponse?: (failure: GatewayResponseFailure) => void;
}

/** Reports `response` to `observers` and returns it untouched. */
async function observeGatewayResponse(
  response: Response,
  observers: GatewayResponseObservers,
): Promise<Response> {
  observers.onResponse?.(gatewayResponseInfo(response));
  if (response.ok || !observers.onErrorResponse) return response;
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
  observers.onErrorResponse({
    status: response.status,
    statusText: response.statusText,
    body,
    retryAfter: response.headers.get("retry-after"),
  });
  return response;
}

/** What carried a model request: the household ChatGPT plan or the gateway. */
export type GatewayTransport = "gateway" | "chatgpt";

/**
 * The household's ChatGPT plan: null only when no plan is connected. A
 * connected plan calls `onSelected` before inference and throws on failure,
 * so the call is never retried through the paid gateway.
 */
export type ChatGptInference = (
  body: GatewayQuery,
  options?: {
    signal?: AbortSignal;
    requestTimeoutMs?: number;
    onSelected?: () => void;
  },
) => Promise<Response | null>;

/** One provider request as a gateway route receives it. */
export interface GatewayFetchRequest {
  endpoint: string;
  /** The SDK's headers without its placeholder credentials. */
  headers: Headers;
  input: RequestInfo | URL;
  init: RequestInit | undefined;
  signal: AbortSignal | undefined;
  /** The decoded (and rewritten) provider body; decoded once, on first use. */
  query: () => Promise<GatewayQuery>;
}

export interface GatewayFetchRoutes extends GatewayResponseObservers {
  /** The gateway provider segment the SDK's placeholder base names. */
  provider: string;
  /**
   * A harness peer standing in for the gateway, resolved per request and
   * checked before any other route; it reports the `gateway` transport.
   */
  testPeer?: () =>
    | ((request: GatewayFetchRequest) => Promise<Response>)
    | undefined;
  /** The household plan, tried first for `openai/responses`. */
  chatGpt?: ChatGptInference;
  requestTimeoutMs?: number;
  /** Rewrites the provider body on every route that decodes it. */
  rewriteQuery?: (query: GatewayQuery) => GatewayQuery;
  /** Called before the request leaves with what will carry it. */
  onTransport?: (transport: GatewayTransport) => void;
  /** The paid gateway route. */
  gateway: (request: GatewayFetchRequest) => Promise<Response>;
}

/**
 * A `fetch` any provider SDK can be handed: the test peer when the harness
 * supplies one, else the connected ChatGPT plan for Responses calls (whose
 * failure never falls back to the gateway), else the gateway. Every received
 * response is reported to the observers and returned untouched, so streaming
 * bodies pass straight through to the SDK.
 */
export function gatewayFetchThrough(routes: GatewayFetchRoutes): typeof fetch {
  return async (input, init) => {
    const endpoint = endpointFor(routes.provider, requestUrl(input));
    let decoded: Promise<GatewayQuery> | undefined;
    const request: GatewayFetchRequest = {
      endpoint,
      headers: strippedHeaders(init),
      input,
      init,
      signal: init?.signal ?? undefined,
      query: () =>
        (decoded ??= gatewayQuery(init?.body).then(
          (query) => routes.rewriteQuery?.(query) ?? query,
        )),
    };
    const observe = (response: Response) =>
      observeGatewayResponse(response, routes);

    const testPeer = routes.testPeer?.();
    if (testPeer) {
      routes.onTransport?.("gateway");
      return observe(await testPeer(request));
    }
    if (
      routes.chatGpt &&
      routes.provider === "openai" &&
      endpoint === "responses"
    ) {
      const subscription = await routes.chatGpt(await request.query(), {
        signal: request.signal,
        requestTimeoutMs: routes.requestTimeoutMs,
        onSelected: () => routes.onTransport?.("chatgpt"),
      });
      if (subscription) return observe(subscription);
    }
    routes.onTransport?.("gateway");
    return observe(await routes.gateway(request));
  };
}

/** Cubby's AI Gateway as the Worker binding exposes it (`AiGateway.run`). */
export interface UniversalGateway {
  run(
    request: {
      provider: string;
      endpoint: string;
      headers: Record<string, string>;
      query: unknown;
    },
    options: {
      gateway: GatewayControls & { id?: string };
      signal?: AbortSignal;
    },
  ): Promise<Response>;
}

/** A provider request over the binding's Universal endpoint. */
export async function runUniversalGateway(
  gateway: UniversalGateway,
  provider: string,
  request: GatewayFetchRequest,
  controls: GatewayControls & { id?: string },
): Promise<Response> {
  return gateway.run(
    {
      provider,
      endpoint: request.endpoint,
      headers: Object.fromEntries(request.headers.entries()),
      query: await request.query(),
    },
    { gateway: controls, signal: request.signal },
  );
}
