/** Cloudflare-native custom spans; non-Worker callers run without tracing. */
import { z } from "zod";

declare const __CF_WORKERS__: boolean | undefined;
const isCloudflareWorkerBuild = (
  flag: boolean | undefined = typeof __CF_WORKERS__ === "undefined"
    ? undefined
    : __CF_WORKERS__,
): flag is true => flag === true;
const IS_CF = isCloudflareWorkerBuild();

/** Minimal shape of the `cloudflare:workers` `tracing` API we depend on. */
interface CfSpan {
  setAttribute(key: string, value: string | number | boolean | undefined): void;
  readonly isTraced: boolean;
  end(): void;
}
interface CfTracing {
  enterSpan<T>(name: string, cb: (span: CfSpan) => T): T;
  startActiveSpan<T>(name: string, cb: (span: CfSpan) => T): T;
  getActiveSpan?(): CfSpan | undefined;
}

const cfRuntimeModuleSchema = z.object({
  tracing: z.custom<CfTracing>(),
});

const traceExceptionSchema = z.union([z.instanceof(Error), z.string()]);

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

type Attr = string | number | boolean | undefined;

/**
 * Minimal span surface our call sites use. Cloudflare spans mark thrown errors
 * automatically through {@link withTrace}; callers only need
 * `setError` for non-throwing failures (for example, a rejected Start result).
 */
export interface AppSpan {
  /**
   * False when this request was not sampled, so nothing set on the span will be
   * exported. Gate *expensive* attribute work on it (string slicing, object
   * building) — a plain literal attribute is cheaper to set than to guard.
   * Always true while every Worker runs `head_sampling_rate: 1`; the point is
   * that lowering the rate is then a wrangler edit, not a code change.
   */
  readonly isRecording: boolean;
  setAttribute(key: string, value: Attr): void;
  setAttributes(attrs: Record<string, Attr>): void;
  /** Mark the span as errored (degrades to attributes in the CF backend). */
  setError(message?: string): void;
  /** Record an exception (degrades to an attribute in the CF backend). */
  recordException<TError>(error: TError): void;
}

const NOOP_SPAN: AppSpan = {
  isRecording: false,
  setAttribute() {},
  setAttributes() {},
  setError() {},
  recordException() {},
};

const wrapCf = (span: CfSpan): AppSpan => ({
  isRecording: span.isTraced,
  setAttribute: (k, v) => {
    if (v !== undefined) span.setAttribute(k, v);
  },
  setAttributes: (attrs) => {
    for (const [k, v] of Object.entries(attrs))
      if (v !== undefined) span.setAttribute(k, v);
  },
  setError: () => {
    span.setAttribute("error", true);
  },
  recordException: (error) => {
    const parsed = traceExceptionSchema.safeParse(error);
    span.setAttribute(
      "error.type",
      parsed.success
        ? parsed.data instanceof Error
          ? parsed.data.name || "Error"
          : "string"
        : "NonErrorThrow",
    );
  },
});

/**
 * Run `fn` inside a Cloudflare span, mark thrown errors, and end it when work
 * settles. Outside Workers, run directly with a non-recording span.
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
        span.setError();
        throw error;
      }
      // CF auto-ends the span when the returned promise settles.
    });
  }

  return fn(NOOP_SPAN);
};

/** Run work under a span whose lifetime is explicitly ended by the caller. */
export const withManualTrace = async <T>(
  name: string,
  fn: (span: AppSpan, end: () => void) => Promise<T>,
  attributes?: Record<string, Attr>,
): Promise<T> => {
  if (IS_CF) {
    const tracing = await getCfTracing();
    return tracing.startActiveSpan(name, async (cfSpan) => {
      const span = wrapCf(cfSpan);
      if (attributes) span.setAttributes(attributes);
      try {
        return await fn(span, () => cfSpan.end());
      } catch (error) {
        span.recordException(error);
        span.setError();
        cfSpan.end();
        throw error;
      }
    });
  }

  return fn(NOOP_SPAN, () => {});
};

/** Synchronous work uses the native runtime warmed by its enclosing span. */
export const withSynchronousManualTrace = <T>(
  name: string,
  fn: (span: AppSpan, end: () => void) => T,
): T => {
  const tracing = IS_CF ? cfTracing : undefined;
  if (!tracing) return fn(NOOP_SPAN, () => {});
  return tracing.startActiveSpan(name, (cfSpan) => {
    const span = wrapCf(cfSpan);
    try {
      return fn(span, () => cfSpan.end());
    } catch (error) {
      span.recordException(error);
      span.setError();
      cfSpan.end();
      throw error;
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

/** Annotate a native active span when the caller has no span reference. */
export const annotateActiveSpanError = (
  attributes: Record<string, Attr>,
  failure?: { message: string; exception?: unknown },
): void => {
  const active = IS_CF ? cfTracing?.getActiveSpan?.() : undefined;
  if (!active) return;
  const span = wrapCf(active);
  span.setAttributes(attributes);
  if (failure) {
    span.setError();
    span.recordException(failure.exception);
  }
};
