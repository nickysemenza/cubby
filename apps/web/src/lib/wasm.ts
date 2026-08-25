/**
 * WASM Module - Loaded at module initialization via top-level await
 *
 * Usage: Import `wasm` and call methods synchronously - works everywhere.
 * Vite handles the top-level await natively.
 */

import type * as RecipeBridge from "@cubby/recipebridge";
import { flatten } from "flat";
import { LRUCache } from "lru-cache";
import type { ReadonlyDeep } from "type-fest";
import { getFlag } from "~/lib/flags";
import { recordWasmCache, recordWasmExec } from "~/lib/perf/perf-store";
import { getTracer, TraceNames } from "~/server/tracing";

type WasmType = typeof RecipeBridge;

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
 * the cache key itself. Byte-array / driver methods (chunk_epub/extract_cookbook)
 * are excluded — huge keys, called once, and the driver isn't pure (callbacks).
 */
const CACHEABLE_METHODS = [
  "parse_ingredient",
  // Batch sibling of parse_ingredient — one call per array of lines, output
  // order matching input. The cache key is the *whole* lines array
  // (`JSON.stringify`), which only hits on an identical batch, not per-line;
  // that's fine because every call site is a paste/import/report surface that
  // re-renders with the same lines (not a per-keystroke surface — those stay
  // on single `parse_ingredient`, which still gets its own fine-grained entries).
  "parse_ingredient_lines",
  "decompose_ingredient",
  "parse_rich_text",
  "conv_amount_to_kind",
  "conv_amount_explain",
  "format_amount",
  // Mapping synthesis from product/food data — pure, called per product per
  // render (table mapping columns, detail pages) with identical args.
  "unit_mappings_from_food",
  "product_unit_mappings",
  // One yield + a short amounts array, so the key is tiny. Worth caching where
  // its sibling `expand_recipe_needs` isn't: the recipe tree has no memo, so a
  // sub-recipe referenced from two places re-expands and asks this the same
  // question each time.
  "recipe_yield_fraction",
] as const;
// NOTE: cost_recipes and expand_recipe_needs are deliberately NOT cached —
// their args are whole recipe closures (multi-KB stringify keys, fresh object
// identities every render); React useMemo + the persisted-totals service
// already dedupe the calls.
/** Source of truth shared by the runtime cache and the `ImmutableWasm` types. */
type CacheableMethod = (typeof CACHEABLE_METHODS)[number];
const cacheableMethods = new Set<string>(CACHEABLE_METHODS);

// Bounded LRU keyed by `${method}:${JSON.stringify(args)}`. Results are never
// nullish (the cached methods return strings/numbers/objects), so a `get`
// returning undefined unambiguously means "miss".
const resultCache = new LRUCache<string, NonNullable<unknown>>({ max: 2048 });

/** Compact, non-dumping summary of a WASM call's args for the slow-call warning. */
const summarizeArg = (arg: unknown): string => {
  if (arg instanceof Uint8Array || arg instanceof ArrayBuffer) {
    return `Uint8Array(${arg.byteLength})`;
  }
  if (typeof arg === "string") {
    return arg.length > 64 ? `"${arg.slice(0, 61)}…"` : JSON.stringify(arg);
  }
  if (Array.isArray(arg)) return `Array(${arg.length})`;
  if (arg && typeof arg === "object") return "{…}";
  return String(arg);
};

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
        console.warn(
          `[wasm] ${name} took ${durationMs.toFixed(1)}ms`,
          args.map(summarizeArg).join(", "),
        );
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
