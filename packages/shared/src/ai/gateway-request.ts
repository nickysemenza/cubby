import { createParser, type EventSourceMessage } from "eventsource-parser";
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
 * Complete SSE events decoded from raw bytes. Line endings are normalized only
 * for parsing; callers forward the original bytes. `onOverflow` reports a frame
 * beyond the parser's bounded buffer.
 */
function sseEventFeed(
  onEvent: (event: EventSourceMessage) => void,
  onOverflow: () => void,
): (bytes: Uint8Array) => void {
  const decoder = new TextDecoder();
  let trailingCR = false;
  const parser = createParser({
    // Framing counts toward parser buffering, but not decoded error data.
    maxBufferSize: 65_536,
    onError: (error) => {
      // SSE ignores unknown fields and invalid retry hints.
      if (error.type === "max-buffer-size-exceeded") onOverflow();
    },
    onEvent,
  });
  return (bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (!text) return;
    const framed = trailingCR && text.startsWith("\n") ? text.slice(1) : text;
    trailingCR = text.endsWith("\r");
    parser.feed(framed.replace(/\r\n?/gu, "\n"));
  };
}

/** One SSE event's type and, when it reports a failure, only its error. */
function classifyStreamEvent(event: EventSourceMessage) {
  if (event.data.length > 16_384) return { type: event.event ?? "unnamed" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(event.data);
  } catch {
    return { type: event.event ?? "unnamed" };
  }
  // A JSON-string `event: error` is the error itself; other strings are output.
  const message = z.string().safeParse(decoded);
  if (event.event === "error" && message.success)
    return { type: event.event, error: message.data };
  const envelope = z
    .looseObject({
      type: z.string().optional(),
      error: z.json().optional(),
      response: z.looseObject({ error: z.json().optional() }).optional(),
    })
    .safeParse(decoded);
  const type = event.event ?? envelope.data?.type ?? "unnamed";
  if (
    !envelope.success ||
    (type !== "error" &&
      type !== "response.failed" &&
      envelope.data.error == null &&
      envelope.data.response?.error == null)
  )
    return { type };
  // A failed Response may contain output; only its error is diagnostic.
  return {
    type,
    error:
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
  };
}

/** Event types seen before a stream error, without their data. */
function priorStreamEvents() {
  const types: string[] = [];
  let seen = 0;
  return {
    record(type: string) {
      seen += 1;
      if (types.length < 8) types.push(type.slice(0, 200));
    },
    failure(
      response: Response,
      type: string,
      error: ReturnType<typeof classifyStreamEvent>["error"],
    ): GatewayResponseFailure {
      const diagnostic = `SSE ${JSON.stringify({ event: type.slice(0, 200), contentType: response.headers.get("content-type"), requestId: response.headers.get("x-request-id"), priorEvents: types, eventsSeen: seen })}\n${JSON.stringify(error)}`;
      return {
        status: response.status,
        statusText: response.statusText,
        retryAfter: response.headers.get("retry-after"),
        // Streaming decode drops an incomplete trailing UTF-8 sequence.
        body: new TextDecoder().decode(
          new TextEncoder().encode(diagnostic).subarray(0, 4_096),
          { stream: true },
        ),
      };
    },
  };
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
  const prior = priorStreamEvents();
  let remaining = 65_536;
  let observing = true;
  const feed = sseEventFeed(
    (event) => {
      if (!observing) return;
      const classified = classifyStreamEvent(event);
      if (!("error" in classified)) {
        prior.record(classified.type);
        return;
      }
      observing = false;
      onErrorResponse(
        prior.failure(response, classified.type, classified.error),
      );
    },
    () => {
      observing = false;
    },
  );
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
            feed(bytes);
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

function reportResponse(
  response: Response,
  observers: GatewayResponseObservers,
): void {
  observers.onResponse?.(gatewayResponseInfo(response), {
    status: response.status,
    contentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-request-id"),
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
  reportResponse(response, observers);
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

const subscriptionQuotaCode = z.object({
  code: z.literal("subscription_sharing_usage_limit_exceeded"),
});
const subscriptionQuotaRefusal = z.object({ error: subscriptionQuotaCode });

/** A complete HTTP quota refusal; streams use {@link admitSubscriptionStream}. */
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
 * Stream lifecycle metadata that carries no model output: the only events a
 * recoverable quota refusal may follow.
 */
// This admission schema is intentionally narrower than diagnostic parsing.
// New provider fields replay unchanged until their pre-output semantics are known.
const preOutputMetadata = z.strictObject({
  type: z.enum(["response.created", "response.in_progress"]),
  sequence_number: z.number().int().nonnegative().optional(),
  response: z.strictObject({
    id: z.string().optional(),
    object: z.literal("response").optional(),
    created_at: z.number().optional(),
    status: z.enum(["queued", "in_progress"]).optional(),
    output: z.tuple([]).optional(),
    output_text: z.literal("").optional(),
    error: z.null().optional(),
    completed_at: z.null().optional(),
    incomplete_details: z.null().optional(),
    usage: z.null().optional(),
    model: z.string().optional(),
    instructions: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
    parallel_tool_calls: z.boolean().optional(),
    background: z.boolean().nullable().optional(),
    store: z.boolean().optional(),
    max_output_tokens: z.number().nullable().optional(),
    max_tool_calls: z.number().nullable().optional(),
    previous_response_id: z.string().nullable().optional(),
    prompt_cache_key: z.string().nullable().optional(),
    prompt_cache_retention: z.enum(["in_memory", "24h"]).nullable().optional(),
    safety_identifier: z.string().nullable().optional(),
    service_tier: z.string().nullable().optional(),
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    top_logprobs: z.number().nullable().optional(),
    truncation: z.enum(["auto", "disabled"]).nullable().optional(),
    user: z.string().optional(),
    reasoning: z
      .strictObject({
        effort: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    text: z
      .strictObject({
        format: z.json().optional(),
        verbosity: z.string().optional(),
      })
      .optional(),
    tool_choice: z.json().optional(),
    tools: z.array(z.json()).optional(),
  }),
});

const streamQuotaError = z.strictObject({
  type: z.enum(["error", "invalid_request_error"]).optional(),
  code: subscriptionQuotaCode.shape.code,
  message: z.string().optional(),
  param: z.string().nullable().optional(),
  sequence_number: z.number().int().nonnegative().optional(),
});
const streamQuotaEnvelope = z.union([
  streamQuotaError,
  z.strictObject({
    type: z.literal("error").optional(),
    error: streamQuotaError,
    sequence_number: z.number().int().nonnegative().optional(),
  }),
]);

/** Bounds on a held subscription stream prefix before it is handed back. */
const STREAM_ADMISSION_BYTES = 65_536;
const STREAM_ADMISSION_MS = 30_000;

function streamAdmissionDecision(
  reason: string,
  event?: string,
  issues?: z.core.$ZodIssue[],
) {
  return {
    reason,
    event: event?.slice(0, 80),
    issues: issues?.slice(0, 4).map((issue) => ({
      code: issue.code,
      path: issue.path.slice(0, 4).map((part) => String(part).slice(0, 40)),
      keys:
        issue.code === "unrecognized_keys"
          ? issue.keys.slice(0, 4).map((key) => key.slice(0, 40))
          : undefined,
    })),
  };
}

function streamAdmissionDiagnostic(
  decision: ReturnType<typeof streamAdmissionDecision>,
  started: number,
  heldBytes: number,
) {
  const description = {
    reason: decision.reason,
    event: decision.event,
    streamRequested: true,
    elapsedMs: Date.now() - started,
    inspectedBytes: heldBytes,
    issues: decision.issues,
  };
  const serialize = () =>
    `Subscription stream admission: ${JSON.stringify(description)}`;
  let diagnostic = serialize();
  // Keep required evidence and valid JSON; escaped structural keys consume
  // bytes too. The separator belongs to the same 2 KiB allowance.
  while (
    new TextEncoder().encode(diagnostic).byteLength > 2_047 &&
    description.issues?.length
  ) {
    description.issues.pop();
    diagnostic = serialize();
  }
  return diagnostic;
}

/**
 * Holds a requested subscription stream until its first event that is not
 * pre-output metadata. Only a complete exact quota `error` there is
 * recoverable. Anything else — output, tools, reasoning, unknown or malformed
 * events, other errors, EOF, a read failure, or the byte/time bound — hands
 * back the held bytes unchanged ahead of the unread remainder, so a later
 * error stays the SDK's and is never replayed through a paid route.
 */
async function admitSubscriptionStream(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<
  { quota: GatewayResponseFailure } | { response: Response; diagnostic: string }
> {
  if (!response.body)
    return {
      response,
      diagnostic: 'Subscription stream admission: {"reason":"no_body"}',
    };
  const started = Date.now();
  let decision = streamAdmissionDecision("eof");
  const reject = (
    reason: string,
    event?: string,
    issues?: z.core.$ZodIssue[],
  ) => {
    if (replay) return;
    replay = true;
    decision = streamAdmissionDecision(reason, event, issues);
  };
  const reader = response.body.getReader();
  const held: Uint8Array[] = [];
  const prior = priorStreamEvents();
  let heldBytes = 0;
  let quota: GatewayResponseFailure | undefined;
  let replay = false;
  const feed = sseEventFeed(
    (event) => {
      if (replay || quota) return;
      let metadata: unknown;
      try {
        metadata = JSON.parse(event.data);
      } catch {
        metadata = undefined;
      }
      if (event.event === "error") {
        const refusal = streamQuotaEnvelope.safeParse(metadata);
        if (refusal.success) {
          const error =
            "error" in refusal.data ? refusal.data.error : refusal.data;
          quota = prior.failure(response, "error", error);
        } else reject("quota_schema", event.event, refusal.error.issues);
        return;
      }
      const parsed = preOutputMetadata.safeParse(metadata);
      if (parsed.success && event.event === parsed.data.type)
        prior.record(parsed.data.type);
      else
        reject(
          parsed.success ? "event_mismatch" : "metadata_schema",
          event.event,
          parsed.success ? undefined : parsed.error.issues,
        );
    },
    () => {
      reject("frame_overflow");
    },
  );
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let stop: (reason: "expired" | "aborted") => void = () => {};
  const stopped = new Promise<"expired" | "aborted">((resolve) => {
    stop = resolve;
  });
  const timer = setTimeout(() => stop("expired"), STREAM_ADMISSION_MS);
  const onAbort = () => stop("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const decided = () => replay || quota !== undefined;
    while (!decided() && heldBytes < STREAM_ADMISSION_BYTES) {
      pending ??= reader.read();
      const part = await Promise.race([pending, stopped]);
      if (part === "aborted") {
        signal?.throwIfAborted();
        break;
      }
      if (part === "expired") {
        reject("timeout");
        break;
      }
      pending = undefined;
      if (part.done) break;
      held.push(part.value);
      const inspect = part.value.subarray(
        0,
        STREAM_ADMISSION_BYTES - heldBytes,
      );
      heldBytes += inspect.byteLength;
      feed(inspect);
    }
  } catch (error) {
    if (signal?.aborted) {
      await reader.cancel(signal.reason).catch(() => {
        // SILENT: the caller's abort is the failure that matters.
      });
      throw error;
    }
    reject("read_failure");
    // SILENT: a failed read reaches the SDK from the original reader below.
    pending = undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!quota && !replay && heldBytes >= STREAM_ADMISSION_BYTES)
    reject("byte_limit");
  if (quota && !replay) {
    void reader.cancel().catch(() => {
      // SILENT: cleanup cannot replace the recovered quota diagnostics.
    });
    return { quota };
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const chunk = held.shift();
        if (chunk) {
          controller.enqueue(chunk);
          return;
        }
        const part = await (pending ?? reader.read());
        pending = undefined;
        if (part.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(part.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return {
    diagnostic: streamAdmissionDiagnostic(decision, started, heldBytes),
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
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

async function routeSubscriptionResponse(
  subscription: Response,
  routes: GatewayFetchRoutes,
  request: GatewayFetchRequest,
  budgetedFallback: boolean,
  streamRequested: boolean,
): Promise<Response | null> {
  if (budgetedFallback && subscription.ok && streamRequested) {
    const admitted = await admitSubscriptionStream(
      subscription,
      request.signal,
    );
    if ("response" in admitted)
      return observeGatewayResponse(
        admitted.response,
        {
          ...routes,
          onErrorResponse: routes.onErrorResponse
            ? (failure) =>
                routes.onErrorResponse?.({
                  ...failure,
                  body: `${failure.body}\n${admitted.diagnostic}`,
                })
            : undefined,
        },
        true,
      );
    reportResponse(subscription, routes);
    routes.onErrorResponse?.(admitted.quota);
    routes.onRecoveredErrorResponse?.(admitted.quota);
  } else {
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
      streamRequested,
    );
    if (!recover) return observedSubscription;
    await subscription.body?.cancel();
  }
  return null;
}

/**
 * A `fetch` any provider SDK can be handed: the test peer when the harness
 * supplies one, else the connected ChatGPT plan for Responses calls, else the
 * gateway. Explicit budgeted fallback may replay a definitive quota refusal —
 * a complete HTTP 429, or a requested stream's quota `error` before any output
 * ({@link admitSubscriptionStream}) — only after durable paid admission. Every received
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
        const result = await routeSubscriptionResponse(
          subscription,
          routes,
          request,
          budgetedFallback,
          await streamRequested(),
        );
        if (result) return result;
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
