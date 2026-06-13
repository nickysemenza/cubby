/**
 * WASM Module - Loaded at module initialization via top-level await
 *
 * Usage: Import `wasm` and call methods synchronously - works everywhere.
 * Vite handles the top-level await natively.
 */

import { flatten } from "flat";
import { LRUCache } from "lru-cache";
import type { ReadonlyDeep } from "type-fest";
import { getFlag } from "~/lib/flags";
import { recordWasmCache, recordWasmExec } from "~/lib/perf/perf-store";
import { getTracer, TraceNames } from "~/server/tracing";

type WasmType = typeof import("@cubby/recipebridge");

/**
 * The `wasm` proxy caches results for pure methods, so every object it returns
 * may be a SHARED reference. This wraps each method's return type in
 * `ReadonlyDeep` so the compiler rejects in-place mutation (`.pop()`, field
 * assignment, etc.) at the call site instead of relying on convention. (A runtime
 * deep-freeze was tried as a belt-and-suspenders guard but tripped a dev-only
 * React warning by freezing objects a library tags in place, with no real
 * mutation to catch — the compile-time types are the guarantee.)
 */
type ImmutableWasm<T> = {
  [K in keyof T]: K extends CacheableMethod
    ? T[K] extends (...args: infer A) => infer R
      ? (...args: A) => ReadonlyDeep<R>
      : T[K]
    : T[K];
};

// Load WASM at module initialization (Vite handles top-level await)
const instance: WasmType = await import("@cubby/recipebridge");

/** For tests - now a no-op since WASM loads at module init */
export const ensureWasm = (): Promise<void> => Promise.resolve();

/**
 * Warn when a single synchronous WASM call exceeds one 60fps frame
 * (~16ms) and thus janks the UI. Set above normal-but-slow calls (parse_rich_text
 * runs ~2-8ms on long instructions) so the warning flags real frame drops rather
 * than spamming every recipe page. Tunable.
 */
const SLOW_WASM_THRESHOLD_MS = 16;

/**
 * Memoize results for these methods, keyed by their args. They are *pure*
 * (output depends only on input) and get called with identical args many times
 * per page as React re-renders during query streaming — profiling showed ~23×
 * redundancy on a recipe page. Only the genuinely expensive methods are listed;
 * trivially cheap ones (is_valid_unit ~0.1µs, amount_kind ~0.5µs) cost less than
 * the cache key itself. Byte-array methods (chunk_epub/assemble_recipes) are
 * excluded — huge keys, called once.
 */
const CACHEABLE_METHODS = [
  "parse_ingredient",
  "decompose_ingredient",
  "parse_rich_text",
  "conv_amount_to_kind",
  "conv_amount_explain",
  "format_amount",
  // Mapping synthesis from product/food data — pure, called per product per
  // render (table mapping columns, detail pages) with identical args.
  "unit_mappings_from_food",
  "product_unit_mappings",
] as const;
// NOTE: cost_recipes is deliberately NOT cached — its args are whole recipe
// closures (multi-KB stringify keys, fresh object identities every render);
// React useMemo + the persisted-totals service already dedupe the calls.
/** Source of truth shared by the runtime cache and the `ImmutableWasm` types. */
type CacheableMethod = (typeof CACHEABLE_METHODS)[number];
const cacheableMethods = new Set<string>(CACHEABLE_METHODS);

// Bounded LRU keyed by `${method}:${JSON.stringify(args)}`. Results are never
// nullish (the cached methods return strings/numbers/objects), so a `get`
// returning undefined unambiguously means "miss".
const resultCache = new LRUCache<string, NonNullable<unknown>>({ max: 2048 });

/** Invoke the real WASM method inside a trace span (+ dev slow-call warning). */
const tracedCall = (
  name: string,
  method: (...args: unknown[]) => unknown,
  args: unknown[],
): unknown => {
  const tracer = getTracer();
  return tracer.startActiveSpan(TraceNames.wasm(name), (span) => {
    const recording = span.isRecording();
    const start = performance.now();
    let threw = false;
    try {
      return method(...args);
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      const durationMs = performance.now() - start;
      // The expensive attribute work (`flatten` + `setAttributes`) is gated on
      // `isRecording()`: in the browser the tracer is a no-op, so it would
      // otherwise run on every call and be thrown away.
      if (recording) {
        span.setAttributes({
          "wasm.method": name,
          "wasm.duration_us": Math.round(durationMs * 1000),
          data: flatten(args),
        });
      }
      if (getFlag("perfOverlay")) recordWasmExec(name, durationMs, threw);
      // Flag-gated (default on in dev, off in CF prod) — flippable on /settings.
      if (getFlag("wasmSlowWarn") && durationMs > SLOW_WASM_THRESHOLD_MS) {
        // eslint-disable-next-line no-console
        console.warn(`[wasm] ${name} took ${durationMs.toFixed(1)}ms`, ...args);
      }
      span.end();
    }
  });
};

/**
 * WASM module with OpenTelemetry tracing + a result cache for pure methods.
 * All methods are synchronous - WASM is guaranteed loaded at module init.
 */
export const wasm: ImmutableWasm<WasmType> = new Proxy(instance, {
  get(target, prop) {
    const method = target[prop as keyof WasmType];
    if (typeof method !== "function") {
      return method;
    }
    const name = String(prop);
    const fn = method as (...args: unknown[]) => unknown;
    if (!cacheableMethods.has(name)) {
      return (...args: unknown[]) => tracedCall(name, fn, args);
    }
    return (...args: unknown[]) => {
      const key = `${name}:${JSON.stringify(args)}`;
      const cached = resultCache.get(key); // updates recency on hit
      if (cached !== undefined) {
        if (getFlag("perfOverlay"))
          recordWasmCache(name, true, resultCache.size);
        return cached;
      }
      const result = tracedCall(name, fn, args);
      resultCache.set(key, result as NonNullable<unknown>);
      if (getFlag("perfOverlay"))
        recordWasmCache(name, false, resultCache.size);
      return result;
    };
  },
});
