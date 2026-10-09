import { createParser } from "eventsource-parser";
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
  collectPayload?: boolean;
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
  "cf-aig-collect-log-payload"?: string;
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
  if (controls.collectPayload !== undefined)
    headers["cf-aig-collect-log-payload"] = String(controls.collectPayload);
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

/** Bounded wire evidence for a response that carries no error envelope. */
export interface GatewayResponseWire {
  status: number;
  contentType: string | null;
  requestId: string | null;
}

/** Observers every transport branch reports each received response to. */
export interface GatewayResponseObservers {
  /**
   * Every received response, without consuming its body. `wire` is always
   * supplied here; it stays optional so test doubles may report `info` alone.
   */
  onResponse?: (info: GatewayResponseInfo, wire?: GatewayResponseWire) => void;
  /** Preserve HTTP or bounded SSE error diagnostics before the SDK replaces them. */
  onErrorResponse?: (failure: GatewayResponseFailure) => void;
  /** An observed refusal is being recovered; it is no longer the terminal failure. */
  onRecoveredErrorResponse?: (failure: GatewayResponseFailure) => void;
}

/**
 * Observe only the bounded prefix the SDK itself reads. Never clone/tee a live
 * stream, pull ahead, retain model output, or make stream errors replayable.
 */
function observeStreamFailure(
  response: Response,
  onErrorResponse: NonNullable<GatewayResponseObservers["onErrorResponse"]>,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const priorEvents: string[] = [];
  let eventsSeen = 0;
  let remaining = 65_536;
  let observing = true;
  let trailingCR = false;
  const recordPriorEvent = (type: string) => {
    eventsSeen += 1;
    if (priorEvents.length < 8) priorEvents.push(type.slice(0, 200));
  };
  const report = (type: string, errorData: GatewayQuery[string]) => {
    observing = false;
    const diagnostic = `SSE ${JSON.stringify({ event: type.slice(0, 200), contentType: response.headers.get("content-type"), requestId: response.headers.get("x-request-id"), priorEvents, eventsSeen })}\n${JSON.stringify(errorData)}`;
    // Streaming decode drops an incomplete trailing UTF-8 sequence.
    const body = new TextDecoder().decode(
      new TextEncoder().encode(diagnostic).subarray(0, 4_096),
      { stream: true },
    );
    onErrorResponse({
      status: response.status,
      statusText: response.statusText,
      retryAfter: response.headers.get("retry-after"),
      body,
    });
  };
  const parser = createParser({
    // Framing counts toward parser buffering, but not decoded error data.
    maxBufferSize: 65_536,
    onError: (error) => {
      // SSE ignores unknown fields and invalid retry hints.
      if (error.type === "max-buffer-size-exceeded") observing = false;
    },
    onEvent: (event) => {
      if (!observing) return;
      if (event.data.length > 16_384) {
        recordPriorEvent(event.event ?? "unnamed");
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch {
        recordPriorEvent(event.event ?? "unnamed");
        return;
      }
      // A JSON-string `event: error` is the error itself; other strings are output.
      const message = z.string().safeParse(decoded);
      if (event.event === "error" && message.success) {
        report(event.event, message.data);
        return;
      }
      const envelope = z
        .looseObject({
          type: z.string().optional(),
          error: z.json().optional(),
          response: z.looseObject({ error: z.json().optional() }).optional(),
        })
        .safeParse(decoded);
      const type = event.event ?? envelope.data?.type ?? "unnamed";
      if (
        envelope.success &&
        (type === "error" ||
          type === "response.failed" ||
          envelope.data.error != null ||
          envelope.data.response?.error != null)
      ) {
        // A failed Response may contain output; only its error is diagnostic.
        report(
          type,
          envelope.data.error ??
            envelope.data.response?.error ??
            z
              .object({
                type: z.string().optional(),
                code: z.json().optional(),
                message: z.json().optional(),
                param: z.json().optional(),
              })
              .parse(envelope.data),
        );
      } else {
        recordPriorEvent(type);
      }
    },
  });
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const part = await reader.read();
        if (part.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        if (observing && remaining > 0) {
          const bytes = part.value.subarray(0, remaining);
          remaining -= bytes.byteLength;
          try {
            const text = decoder.decode(bytes, { stream: true });
            if (text) {
              // Normalize only diagnostic framing; raw SDK bytes stay unchanged.
              const framed =
                trailingCR && text.startsWith("\n") ? text.slice(1) : text;
              trailingCR = text.endsWith("\r");
              parser.feed(framed.replace(/\r\n?/gu, "\n"));
            }
          } catch {
            observing = false; /* Diagnostics cannot replace the SDK's original stream. */
          }
          if (remaining === 0) observing = false;
        }
        controller.enqueue(part.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Reports diagnostics while preserving the SDK’s response bytes and cancellation.
 * A provider SDK that requested a stream parses SSE whatever the response MIME
 * says, so the request — not only `Content-Type` — decides stream observation.
 */
async function observeGatewayResponse(
  response: Response,
  observers: GatewayResponseObservers,
  streamRequested: boolean,
): Promise<Response> {
  observers.onResponse?.(gatewayResponseInfo(response), {
    status: response.status,
    contentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-request-id"),
  });
  if (!observers.onErrorResponse) return response;
  if (response.ok)
    return streamRequested ||
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream"
      ? observeStreamFailure(response, observers.onErrorResponse)
      : response;
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

const subscriptionQuotaRefusal = z.object({
  error: z.object({
    code: z.literal("subscription_sharing_usage_limit_exceeded"),
  }),
});

/** Only an HTTP admission refusal is replayable; never inspect a live SSE stream. */
async function isSubscriptionQuotaRefusal(
  response: Response,
): Promise<boolean> {
  if (response.status !== 429) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let body = "";
  let remaining = 16_384;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done)
        return subscriptionQuotaRefusal.safeParse(
          JSON.parse(body + decoder.decode()),
        ).success;
      if (part.value.length > remaining) return false;
      remaining -= part.value.length;
      body += decoder.decode(part.value, { stream: true });
    }
  } catch {
    // SILENT: an unreadable or unrecognized refusal stays on the original response.
    return false;
  } finally {
    void reader.cancel().catch(() => {
      // SILENT: clone cleanup cannot replace the original subscription diagnostics.
    });
  }
}

/**
 * The household's ChatGPT plan: null only when no plan is connected. A
 * connected plan calls `onSelected` before inference. Transport failures throw;
 * HTTP refusals retain their upstream status and body for routing and diagnostics.
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
  /** A disconnected subscription must wait instead of using a paid chat route. */
  subscriptionRequired?: boolean;
  /** Explicit research fallback, allowed only with durable paid admission. */
  subscriptionFallback?: "budgeted";
  /** Admission completes before each actual paid or synthetic-peer transmission. */
  beforePaidRequest?: (request: GatewayFetchRequest) => Promise<void>;
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
 * supplies one, else the connected ChatGPT plan for Responses calls, else the
 * gateway. Explicit budgeted fallback may replay a definitive quota refusal
 * only after durable paid admission. Every received
 * response is reported to observers. Streaming bytes pass through unchanged;
 * passive error observation never authorizes replay.
 */
export function gatewayFetchThrough(routes: GatewayFetchRoutes): typeof fetch {
  const budgetedFallback =
    routes.subscriptionFallback === "budgeted" &&
    routes.beforePaidRequest !== undefined;
  const requireSubscription =
    (routes.subscriptionRequired ||
      routes.subscriptionFallback === "budgeted") &&
    !budgetedFallback;
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
    // Reads the already-decoded query or a string body; never consumes a stream body.
    const streamRequested = async () => {
      let query: unknown = await decoded;
      const body = z.string().safeParse(init?.body);
      if (!decoded && body.success)
        try {
          query = JSON.parse(body.data);
        } catch {
          // SILENT: an undecodable body falls back to the response MIME.
        }
      return z.object({ stream: z.literal(true) }).safeParse(query).success;
    };
    const observe = async (response: Response) =>
      observeGatewayResponse(response, routes, await streamRequested());

    const testPeer = routes.testPeer?.();
    if (testPeer) {
      await routes.beforePaidRequest?.(request);
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
      if (subscription) {
        const recover =
          budgetedFallback && (await isSubscriptionQuotaRefusal(subscription));
        const observedSubscription = await observeGatewayResponse(
          subscription,
          {
            ...routes,
            onErrorResponse: (failure) => {
              routes.onErrorResponse?.(failure);
              if (recover) routes.onRecoveredErrorResponse?.(failure);
            },
          },
          await streamRequested(),
        );
        if (!recover) return observedSubscription;
        await subscription.body?.cancel();
      }
    }
    if (requireSubscription)
      throw new Error(
        "Required ChatGPT subscription is unavailable; reconnect before retrying.",
      );
    request.signal?.throwIfAborted();
    await routes.beforePaidRequest?.(request);
    request.signal?.throwIfAborted();
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
