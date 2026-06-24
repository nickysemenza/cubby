/**
 * Unified tracing utilities for consistent span naming and a single span API
 * that works across both runtimes.
 *
 * Two backends, picked at build time via the `__CF_WORKERS__` define so the
 * unused one is dead-code-eliminated:
 *
 *  - Dev / Node → the global `@opentelemetry/api` tracer that the dev NodeSDK
 *    (`instrument.server.mjs`, loaded via `--import`) registers, exporting to
 *    Jaeger. Rich span semantics (status, recorded exceptions, W3C context
 *    propagation) all work.
 *  - Deployed CF Worker → the runtime `cloudflare:workers` `tracing.enterSpan`
 *    API (shipped 2026-06-16). Its spans nest under CF's automatic platform
 *    spans and flow into the `grafana-traces` OTLP destination — no OTel SDK
 *    runs in the Worker. The CF `Span` is thinner (`setAttribute` only), so
 *    status / exceptions degrade to attributes and context propagation is
 *    handled automatically by the platform (see the helper no-ops below).
 *
 * Call sites use the unified {@link AppSpan} / {@link withTrace} surface and
 * never import `@opentelemetry/api` directly, so the same instrumentation lights
 * up in both runtimes.
 */
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { getErrorMessage } from "~/lib/error-utils";

declare const __CF_WORKERS__: boolean | undefined;
const IS_CF = typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;

// Single OTel tracer instance — used by the dev `withTrace` backend and by the
// synchronous WASM spans in `~/lib/wasm.ts` (which can't use the async
// `withTrace`). In the deployed Worker no OTel provider is registered, so these
// calls are no-ops; the CF backend below handles prod tracing instead.
const tracer = trace.getTracer("cubby");

/** Minimal shape of the `cloudflare:workers` `tracing` API we depend on. */
interface CfSpan {
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  readonly isTraced: boolean;
}
interface CfTracing {
  enterSpan<T>(name: string, cb: (span: CfSpan) => T): T;
}

// Lazily import the runtime built-in only in the CF bundle. The specifier is
// indirected + `@vite-ignore`d so `vite dev` (Node, which can't resolve
// `cloudflare:workers`) never tries to — the IS_CF branch is dead there anyway.
let cfTracing: CfTracing | undefined;
const getCfTracing = async (): Promise<CfTracing> => {
  if (!cfTracing) {
    const specifier = "cloudflare:workers";
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      tracing: CfTracing;
    };
    cfTracing = mod.tracing;
  }
  return cfTracing;
};

/**
 * Unified trace naming conventions
 */
export const TraceNames = {
  // HTTP routes
  route: (method: string, path: string) => `${method} ${path}`,

  // tRPC procedures
  trpc: (type: string, path: string) => `trpc.${type}.${path}`,

  // External API calls
  api: (service: string, operation: string) => `api.${service}.${operation}`,

  // WASM operations
  wasm: (operation: string) => `wasm.${operation}`,

  // Service layer operations
  service: (service: string, operation: string) =>
    `service.${service}.${operation}`,

  // Database operations
  db: (operation: string) => `db.${operation}`,
} as const;

type Attr = string | number | boolean | undefined;

/**
 * Minimal span surface our call sites use. Backed by an OTel span in dev and a
 * `cloudflare:workers` span in prod. Status is set automatically by
 * {@link withTrace} (OK on success, errored on throw); callers only need
 * `setError` for non-throwing failures (e.g. a tRPC `result.ok === false`).
 */
export interface AppSpan {
  setAttribute(key: string, value: Attr): void;
  setAttributes(attrs: Record<string, Attr>): void;
  /** Mark the span as errored (degrades to attributes in the CF backend). */
  setError(message?: string): void;
  /** Record an exception (degrades to an attribute in the CF backend). */
  recordException(error: unknown): void;
}

/** Get the unified OTel tracer (dev backend + synchronous WASM spans). */
export const getTracer = () => tracer;

const wrapOtel = (span: ReturnType<typeof tracer.startSpan>): AppSpan => ({
  setAttribute: (k, v) => {
    if (v !== undefined) span.setAttribute(k, v);
  },
  setAttributes: (attrs) => span.setAttributes(attrs),
  setError: (message) =>
    span.setStatus({ code: SpanStatusCode.ERROR, message }),
  recordException: (error) =>
    span.recordException(
      error instanceof Error ? error : new Error(String(error)),
    ),
});

const wrapCf = (span: CfSpan): AppSpan => ({
  setAttribute: (k, v) => span.setAttribute(k, v),
  setAttributes: (attrs) => {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  },
  setError: (message) => {
    span.setAttribute("error", true);
    span.setAttribute("error.message", message);
  },
  recordException: (error) =>
    span.setAttribute("exception.message", getErrorMessage(error)),
});

/**
 * Run `fn` inside a trace span. Sets OK status on success and errored status
 * (+ records the exception) on throw, and ends the span automatically.
 */
export const withTrace = async <T>(
  name: string,
  fn: (span: AppSpan) => Promise<T>,
  attributes?: Record<string, Attr>,
): Promise<T> => {
  if (IS_CF) {
    const tracing = await getCfTracing();
    return tracing.enterSpan(name, async (cfSpan) => {
      const span = wrapCf(cfSpan);
      if (attributes) span.setAttributes(attributes);
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error);
        span.setError(getErrorMessage(error));
        throw error;
      }
      // CF auto-ends the span when the returned promise settles.
    });
  }

  return tracer.startActiveSpan(name, async (otelSpan) => {
    const span = wrapOtel(otelSpan);
    if (attributes) span.setAttributes(attributes);
    try {
      const result = await fn(span);
      otelSpan.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setError(getErrorMessage(error));
      throw error;
    } finally {
      otelSpan.end();
    }
  });
};

/**
 * Run a record of async thunks concurrently, each inside its own span named by
 * its key, and return a typed object of their results. The key is the single
 * source of truth — it's both the span name (a string literal, so it survives
 * minification, unlike `fn.name`) and the result accessor — so detector names
 * are never written twice.
 */
export const traceAll = async <
  T extends Record<string, () => Promise<unknown>>,
>(
  tasks: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> => {
  const entries = await Promise.all(
    Object.entries(tasks).map(
      async ([name, run]) => [name, await withTrace(name, run)] as const,
    ),
  );
  return Object.fromEntries(entries) as {
    [K in keyof T]: Awaited<ReturnType<T[K]>>;
  };
};

/**
 * Trace id of the active span, for surfacing to clients (e.g. an `x-trace-id`
 * header). Undefined in the CF backend — its `Span` exposes no trace id.
 */
export const getActiveTraceId = (): string | undefined =>
  IS_CF ? undefined : trace.getActiveSpan()?.spanContext().traceId;

/**
 * Inject W3C trace context into outbound request headers for distributed
 * tracing. No-op in the CF backend — the platform propagates trace context
 * across service-binding subrequests automatically.
 */
export const injectTraceContext = (headers: Record<string, string>): void => {
  if (IS_CF) return;
  propagation.inject(context.active(), headers);
};

/**
 * Extract W3C trace context from inbound headers and run `fn` within it. In the
 * CF backend the platform manages context, so this just runs `fn`.
 */
export const extractTraceContext = async <T>(
  headers: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> => {
  if (IS_CF) return fn();
  const parent = propagation.extract(context.active(), headers);
  return context.with(parent, fn);
};

/**
 * Annotate the currently-active span with error metadata, out-of-band (i.e.
 * without a span reference in hand — used by `createAppError`). No-op in the CF
 * backend, which exposes no accessor for the active span outside an
 * `enterSpan` callback.
 */
export const annotateActiveSpanError = (
  attributes: Record<string, Attr>,
  failure?: { message: string; exception?: unknown },
): void => {
  if (IS_CF) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttributes(attributes);
  if (failure) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message });
    if (
      failure.exception instanceof Error ||
      typeof failure.exception === "string"
    ) {
      span.recordException(failure.exception);
    }
  }
};
