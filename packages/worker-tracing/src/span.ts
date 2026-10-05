/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a thrown value has no schema; only its constructor name is recorded on the span. */
/**
 * The one implementation of "run work inside a Cloudflare span": attribute
 * handling, error marking and the lifecycle variants. `withSpan` (this
 * package's lazy, Node-tolerant entry) and the web app's `withTrace` (which
 * owns its own runtime-loading policy and trace naming) both delegate here, so
 * how a span records a failure is decided in exactly one place.
 */

export type SpanAttr = string | number | boolean | undefined;

/** The subset of the `cloudflare:workers` `Span` this package depends on. */
export interface CfSpan {
  setAttribute(key: string, value?: SpanAttr): void;
  readonly isTraced: boolean;
  end(): void;
}

/** The subset of the `cloudflare:workers` `tracing` API this package depends on. */
export interface CfTracing {
  enterSpan<T>(name: string, cb: (span: CfSpan) => T): T;
  startActiveSpan<T>(name: string, cb: (span: CfSpan) => T): T;
  getActiveSpan?(): CfSpan | undefined;
}

/**
 * The span surface call sites use. The CF `Span` has no status or exception
 * API, so `setError` and `recordException` degrade to attributes.
 */
export interface TraceSpan {
  /**
   * False when this request was not sampled, so nothing set on the span will
   * be exported. Gate *expensive* attribute work on it.
   */
  readonly isRecording: boolean;
  setAttribute(key: string, value: SpanAttr): void;
  setAttributes(attrs: Record<string, SpanAttr>): void;
  /** Mark the span as errored. */
  setError(message?: string): void;
  /** Record an exception's type (never its message, which may carry data). */
  recordException(error: unknown): void;
}

export const NOOP_TRACE_SPAN: TraceSpan = {
  isRecording: false,
  setAttribute() {},
  setAttributes() {},
  setError() {},
  recordException() {},
};

const exceptionType = (error: unknown): string => {
  if (error instanceof Error) return error.name || "Error";
  return typeof error === "string" ? "string" : "NonErrorThrow";
};

export const wrapCfSpan = (span: CfSpan): TraceSpan => ({
  isRecording: span.isTraced,
  setAttribute: (key, value) => {
    if (value !== undefined) span.setAttribute(key, value);
  },
  setAttributes: (attrs) => {
    for (const [key, value] of Object.entries(attrs))
      if (value !== undefined) span.setAttribute(key, value);
  },
  setError: () => {
    span.setAttribute("error", true);
  },
  recordException: (error) => {
    span.setAttribute("error.type", exceptionType(error));
  },
});

export interface EnterSpanOptions {
  attributes?: Record<string, SpanAttr>;
  /** Extra marking on a thrown error, after the standard `error.type`/`error`. */
  onError?: (span: TraceSpan, error: unknown) => void;
}

const markFailure = (
  span: TraceSpan,
  error: unknown,
  options: EnterSpanOptions | undefined,
) => {
  span.recordException(error);
  span.setError();
  options?.onError?.(span, error);
};

/**
 * Run `fn` inside a span that CF ends when the returned promise settles; a
 * thrown error is marked on the span and rethrown.
 */
export const enterSpan = <T>(
  tracing: CfTracing,
  name: string,
  fn: (span: TraceSpan) => Promise<T>,
  options?: EnterSpanOptions,
): Promise<T> =>
  tracing.enterSpan(name, async (cfSpan) => {
    const span = wrapCfSpan(cfSpan);
    if (options?.attributes) span.setAttributes(options.attributes);
    try {
      return await fn(span);
    } catch (error) {
      markFailure(span, error, options);
      throw error;
    }
  });

/** Entry metadata belongs on the platform invocation and its timing child. */
export const enterInvocationSpan = <T>(
  tracing: CfTracing,
  name: string,
  fn: (span: TraceSpan) => Promise<T>,
  options?: EnterSpanOptions,
): Promise<T> => {
  // Resolve before entering the child and on every invocation; a cached span
  // would leak queue, cron, or Durable Object context across deliveries.
  const active = tracing.getActiveSpan?.();
  if (active && options?.attributes)
    wrapCfSpan(active).setAttributes(options.attributes);
  return enterSpan(tracing, name, fn, options);
};

/** A span whose lifetime the caller ends explicitly (a stream, a long job). */
export const enterManualSpan = <T>(
  tracing: CfTracing,
  name: string,
  fn: (span: TraceSpan, end: () => void) => Promise<T>,
  options?: EnterSpanOptions,
): Promise<T> =>
  tracing.startActiveSpan(name, async (cfSpan) => {
    const span = wrapCfSpan(cfSpan);
    if (options?.attributes) span.setAttributes(options.attributes);
    try {
      return await fn(span, () => cfSpan.end());
    } catch (error) {
      markFailure(span, error, options);
      cfSpan.end();
      throw error;
    }
  });

/** Synchronous sibling of {@link enterManualSpan}. */
export const enterSynchronousManualSpan = <T>(
  tracing: CfTracing,
  name: string,
  fn: (span: TraceSpan, end: () => void) => T,
): T =>
  tracing.startActiveSpan(name, (cfSpan) => {
    const span = wrapCfSpan(cfSpan);
    try {
      return fn(span, () => cfSpan.end());
    } catch (error) {
      markFailure(span, error, undefined);
      cfSpan.end();
      throw error;
    }
  });
