/**
 * WASM Module - Loaded at module initialization via top-level await
 *
 * Usage: Import `wasm`; parsing is synchronous, extraction drivers return Promises.
 * Vite handles the top-level await natively.
 */

import type * as RecipeBridge from "@cubby/recipebridge";
import { LRUCache } from "lru-cache";
import type { ReadonlyDeep } from "type-fest";

import { getFlag } from "~/lib/flags";
import { recordWasmCache } from "~/lib/perf/perf-store";
import { executeWasm } from "~/lib/wasm-execution";

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

type WasmMethod = Extract<
  WasmType[keyof WasmType],
  (...args: never[]) => string | number | boolean | null | undefined | object
>;
type WasmParameters = Parameters<WasmMethod>;
type WasmResult = ReturnType<WasmMethod>;

const isWasmFunction = (value: WasmType[keyof WasmType]): value is WasmMethod =>
  typeof value === "function";

// Bounded LRU keyed by `${method}:${JSON.stringify(args)}`. Results are never
// nullish (the cached methods return strings/numbers/objects), so a `get`
// returning undefined unambiguously means "miss".
const resultCache = new LRUCache<string, NonNullable<WasmResult>>({
  max: 2048,
});

/**
 * WASM module with OpenTelemetry tracing + a result cache for pure methods.
 * WASM is guaranteed loaded at module init. Most methods are synchronous;
 * driver methods retain tracing until their returned Promise settles.
 */
const instrumentedWasm = new Proxy(instance, {
  get(target, prop) {
    // SAFETY: Proxy keys come from the exact imported module target; symbol or
    // absent lookups produce undefined and take the non-function branch below.
    const method = target[prop as keyof WasmType];
    if (!isWasmFunction(method)) {
      return method;
    }
    const name = String(prop);
    // SAFETY: Every runtime value exported by recipebridge is a function
    // whose generated argument and return types are members of these
    // unions; the Proxy handler cannot retain the key-to-signature correlation.
    const fn = method as (...args: WasmParameters) => WasmResult;
    if (!cacheableMethods.has(name)) {
      return (...args: WasmParameters) => executeWasm(name, fn, args);
    }
    return (...args: WasmParameters) => {
      const key = `${name}:${JSON.stringify(args)}`;
      const cached = resultCache.get(key); // updates recency on hit
      if (cached !== undefined) {
        if (getFlag("perfOverlay"))
          recordWasmCache(name, true, resultCache.size);
        return cached;
      }
      const result = executeWasm(name, fn, args);
      if (result !== null && result !== undefined) resultCache.set(key, result);
      if (getFlag("perfOverlay"))
        recordWasmCache(name, false, resultCache.size);
      return result;
    };
  },
});

export const wasm = instrumentedWasm satisfies ImmutableWasm<WasmType>;
