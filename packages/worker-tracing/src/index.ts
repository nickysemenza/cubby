/// <reference path="./cloudflare-workers.d.ts" />
/**
 * @cubby/worker-tracing
 *
 * Minimal custom-span helper over the `cloudflare:workers` `tracing.enterSpan`
 * API (shipped 2026-06-16). For the downstream Workers (usda-api, upc-lookup),
 * which run on workerd in dev *and* prod — so, unlike apps/web, they need no
 * Node/OTel backend. Mirrors the `wrapCf` shape in
 * apps/web/src/server/tracing.ts.
 *
 * Spans created here auto-nest under the request's root span (and, across a
 * service-binding subrequest, under the calling worker's trace — the CF platform
 * propagates context automatically), and flow to the worker's `grafana-traces`
 * OTLP destination. Requires `observability.traces.enabled` in wrangler.jsonc and
 * a `compatibility_date >= 2026-06-16`.
 *
 * The `cloudflare:workers` import is resolved LAZILY and tolerantly: on workerd
 * it's present; under Node (vitest / any non-worker context) the import throws
 * and we fall back to a no-op span so `fn` still runs. That keeps this safe to
 * import from code that's also unit-tested in Node (e.g. usda-api's edge.ts).
 */

export type SpanAttr = string | number | boolean | undefined;

/** The subset of the CF `Span` surface our call sites use. */
export interface WorkerSpan {
  setAttribute(key: string, value: SpanAttr): void;
  setAttributes(attrs: Record<string, SpanAttr>): void;
}

type CfTracing = typeof import("cloudflare:workers").tracing;

// Cached after the first attempt; `null` = checked and absent (non-worker).
let cfTracing: CfTracing | null | undefined;
async function getCfTracing(): Promise<CfTracing | null> {
  if (cfTracing !== undefined) return cfTracing;
  try {
    // Indirected via @vite-ignore so a Vite-built worker (upc-lookup) doesn't
    // try to pre-bundle the runtime-only module; workerd resolves it at runtime.
    const mod = await import(/* @vite-ignore */ "cloudflare:workers");
    cfTracing = mod.tracing;
  } catch {
    cfTracing = null;
  }
  return cfTracing;
}

const NOOP_SPAN: WorkerSpan = {
  setAttribute() {},
  setAttributes() {},
};

/**
 * Run `fn` inside a custom trace span. Applies any `attributes`, and on throw
 * records the error as attributes (the CF `Span` has no status/exception API),
 * then rethrows. The span ends automatically when the returned promise settles.
 * Undefined attribute values are skipped. When no CF tracing runtime is present
 * (Node tests), `fn` runs without a span.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: WorkerSpan) => Promise<T>,
  attributes?: Record<string, SpanAttr>,
): Promise<T> {
  const tracing = await getCfTracing();
  if (!tracing) return fn(NOOP_SPAN);
  return tracing.enterSpan(name, async (cf): Promise<T> => {
    const span: WorkerSpan = {
      setAttribute: (k, v) => {
        if (v !== undefined) cf.setAttribute(k, v);
      },
      setAttributes: (attrs) => {
        for (const [k, v] of Object.entries(attrs)) {
          if (v !== undefined) cf.setAttribute(k, v);
        }
      },
    };
    if (attributes) span.setAttributes(attributes);
    try {
      return await fn(span);
    } catch (error) {
      cf.setAttribute("error", true);
      cf.setAttribute(
        "error.message",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
}
