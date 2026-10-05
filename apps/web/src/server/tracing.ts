/** Cloudflare-native custom spans; non-Worker callers run without tracing. */
import {
  type CfTracing,
  enterManualSpan,
  enterSpan,
  enterSynchronousManualSpan,
  NOOP_TRACE_SPAN,
  type SpanAttr,
  type TraceSpan,
  wrapCfSpan,
} from "@cubby/worker-tracing";
import { z } from "zod";

declare const __CF_WORKERS__: boolean | undefined;
const isCloudflareWorkerBuild = (
  flag: boolean | undefined = typeof __CF_WORKERS__ === "undefined"
    ? undefined
    : __CF_WORKERS__,
): flag is true => flag === true;
const IS_CF = isCloudflareWorkerBuild();

const cfRuntimeModuleSchema = z.object({
  tracing: z.custom<CfTracing>(),
});

// Lazily import the runtime built-in only in the CF bundle. The specifier is
// indirected + `@vite-ignore`d so `vite dev` (Node, which can't resolve
// `cloudflare:workers`) never tries to — the IS_CF branch is dead there anyway.
let cfTracing: CfTracing | undefined;
const getCfTracing = async (): Promise<CfTracing> => {
  if (!cfTracing) {
    const specifier = "cloudflare:workers";
    const mod = cfRuntimeModuleSchema.parse(
      await import(/* @vite-ignore */ specifier),
    );
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

  // MCP tool dispatch
  mcp: (tool: string) => `mcp.tool.${tool}`,

  // External API calls
  api: (service: string, operation: string) => `api.${service}.${operation}`,

  // WASM operations
  wasm: (operation: string) => `wasm.${operation}`,

  // Service layer operations
  service: (service: string, operation: string) =>
    `service.${service}.${operation}`,

  // Database operations
  db: (operation: string) => `db.${operation}`,

  // Background jobs (queue delivery, inline dispatch, and the dev drain all
  // funnel through processBackgroundJob, so the kind is the grouping key).
  job: (kind: string) => `job.${kind}`,
} as const;

/**
 * Minimal span surface our call sites use. Thrown errors are marked by
 * {@link withTrace}; callers only need `setError` for non-throwing failures
 * (for example, a rejected Start result). The implementation lives in
 * `@cubby/worker-tracing`, shared with the downstream Workers.
 */
export type AppSpan = TraceSpan;

/**
 * Run `fn` inside a Cloudflare span, mark thrown errors, and end it when work
 * settles. Outside Workers, run directly with a non-recording span.
 */
export const withTrace = async <T>(
  name: string,
  fn: (span: AppSpan) => Promise<T>,
  attributes?: Record<string, SpanAttr>,
): Promise<T> => {
  if (IS_CF) {
    return enterSpan(await getCfTracing(), name, fn, { attributes });
  }
  return fn(NOOP_TRACE_SPAN);
};

/** Run work under a span whose lifetime is explicitly ended by the caller. */
export const withManualTrace = async <T>(
  name: string,
  fn: (span: AppSpan, end: () => void) => Promise<T>,
  attributes?: Record<string, SpanAttr>,
): Promise<T> => {
  if (IS_CF) {
    return enterManualSpan(await getCfTracing(), name, fn, { attributes });
  }
  return fn(NOOP_TRACE_SPAN, () => {});
};

/** Synchronous work uses the native runtime warmed by its enclosing span. */
export const withSynchronousManualTrace = <T>(
  name: string,
  fn: (span: AppSpan, end: () => void) => T,
): T => {
  const tracing = IS_CF ? cfTracing : undefined;
  if (!tracing) return fn(NOOP_TRACE_SPAN, () => {});
  return enterSynchronousManualSpan(tracing, name, fn);
};

/**
 * Run a record of async thunks concurrently, each inside its own span named by
 * its key, and return a typed object of their results. The key is the single
 * source of truth — it's both the span name (a string literal, so it survives
 * minification, unlike `fn.name`) and the result accessor — so detector names
 * are never written twice.
 */
type TraceTaskResult = string | number | boolean | null | undefined | object;

export const traceAll = async <
  T extends Record<string, () => Promise<TraceTaskResult>>,
>(
  tasks: T,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> => {
  const entries = await Promise.all(
    Object.entries(tasks).map(
      async ([name, run]) => [name, await withTrace(name, run)] as const,
    ),
  );
  // SAFETY: Each entry is emitted from the same task key exactly once; only
  // Object.fromEntries erases that key-to-awaited-result correlation.
  return Object.fromEntries(entries) as {
    [K in keyof T]: Awaited<ReturnType<T[K]>>;
  };
};

/**
 * Concurrent sibling of {@link traceAll} with an explicit task limit.
 *
 * The Problems lanes use this against the request-local five-connection pool:
 * four active tasks overlap remote Postgres latency while one connection stays
 * available for a task's own bounded hydration/count query. The scheduler is
 * generic so the concurrency policy is testable without a database or clock.
 */
export const traceAllBounded = async <
  T extends Record<string, () => Promise<TraceTaskResult>>,
>(
  tasks: T,
  concurrency: number,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("traceAllBounded concurrency must be a positive integer");
  }

  const entries = Object.entries(tasks);
  const results = Array.from(
    { length: entries.length },
    (): readonly [string, TraceTaskResult] => ["", undefined],
  );
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry) return;
      const [name, run] = entry;
      results[index] = [name, await withTrace(name, run)] as const;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, worker),
  );
  // SAFETY: Workers fill the pre-sized slot for every source entry before this
  // join; the slot index preserves each task key's result correlation.
  return Object.fromEntries(results) as {
    [K in keyof T]: Awaited<ReturnType<T[K]>>;
  };
};

/** Request correlation uses the Cloudflare ray recorded on the request span. */
export const getRequestId = (
  headers?: Pick<Headers, "get">,
): string | undefined => headers?.get("cf-ray") ?? undefined;

/** Annotate the native active span when the caller has no span reference. */
export const annotateActiveSpan = (
  attributes: Record<string, SpanAttr>,
): AppSpan | undefined => {
  const active = IS_CF ? cfTracing?.getActiveSpan?.() : undefined;
  if (!active) return undefined;
  const span = wrapCfSpan(active);
  span.setAttributes(attributes);
  return span;
};

/** {@link annotateActiveSpan}, additionally marking the span as failed. */
export const annotateActiveSpanError = (
  attributes: Record<string, SpanAttr>,
  failure?: { message: string; exception?: unknown },
): void => {
  const span = annotateActiveSpan(attributes);
  if (!span) return;
  if (failure) {
    span.setError();
    span.recordException(failure.exception);
  }
};
