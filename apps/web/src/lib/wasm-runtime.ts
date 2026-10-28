import type * as RecipeBridge from "@cubby/recipebridge";
import { LRUCache } from "lru-cache";
import type { ReadonlyDeep } from "type-fest";

import { FLAGS } from "~/lib/flags";
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
export type ImmutableWasm<T> = {
  [K in keyof T]: K extends CacheableMethod
    ? T[K] extends (...args: infer A) => infer R
      ? (...args: A) => ReadonlyDeep<R>
      : T[K]
    : T[K];
};

/**
 * Memoize results for these methods, keyed by their args. They are *pure*
 * (output depends only on input) and get called with identical args many times
 * per page as React re-renders during query streaming — profiling showed ~23×
 * redundancy on a recipe page. Only the genuinely expensive methods are listed;
 * trivially cheap ones (is_valid_unit ~0.1µs, amount_kind ~0.5µs) cost less than
 * the cache key itself.
 */
const CACHEABLE_METHODS = [
  "parse_ingredient",
  // Object inputs bypass the cache; these methods retain readonly result types.
  "parse_ingredient_lines",
  "decompose_ingredient",
  "parse_rich_text",
  "conv_amount_to_kind",
  "conv_amount_explain",
  "format_amount",
  "format_amount_labeled",
  "unit_mappings_from_food",
  "product_unit_mappings",
  "recipe_yield_fraction",
  // Pure ISBN validation/normalization, called on every keystroke of the
  // product forms' ISBN field (live preview + the book-category inference) —
  // same re-render redundancy as `parse_ingredient` above.
  "normalize_isbn",
  "isbn_from_gtin",
] as const;
// Page-sized objects are batched instead of serialized into cache keys.
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

// Both capability surfaces share pure results from the same module. A miss is
// unambiguous because cached methods never return nullish values.
const resultCache = new LRUCache<string, NonNullable<WasmResult>>({
  max: 2048,
});

// Object-heavy work is batched by the caller. Primitive keys avoid allocating
// and retaining a serialized copy of each page's input graph.
const primitiveCacheKey = (
  name: string,
  args: WasmParameters,
): string | undefined => {
  let key = name;
  for (const arg of args) {
    if (arg !== null && typeof arg === "object") return undefined;
    const value = String(arg);
    key += `:${typeof arg}:${value.length}:${value}`;
  }
  return key;
};

/** Cache and trace both typed capability surfaces with the same policy. */
export function instrumentWasm<T extends WasmType>(instance: T): T {
  /**
   * WASM module with execution timing and a result cache for pure methods.
   * The Worker initializes WASM on first use. Most methods are synchronous;
   * driver methods measure completion when their returned Promise settles.
   */
  return new Proxy(instance, {
    get(target, prop) {
      // SAFETY: Proxy keys come from the exact imported module target; symbol or
      // absent lookups produce undefined and take the non-function branch below.
      const method = target[prop as keyof WasmType];
      if (!isWasmFunction(method)) {
        return method;
      }
      const name = String(prop);
      // SAFETY: The proxy forwards arguments and results unchanged; these
      // unions only describe its internal cache. The returned proxy retains
      // T, including Worker-only signatures the common interface omits.
      const fn = method as (...args: WasmParameters) => WasmResult;
      if (!cacheableMethods.has(name)) {
        return (...args: WasmParameters) => executeWasm(name, fn, args);
      }
      return (...args: WasmParameters) => {
        const key = primitiveCacheKey(name, args);
        if (key === undefined) return executeWasm(name, fn, args);
        const cached = resultCache.get(key); // updates recency on hit
        if (cached !== undefined) {
          if (FLAGS.perfOverlay) recordWasmCache(name, true, resultCache.size);
          return cached;
        }
        const result = executeWasm(name, fn, args);
        if (result !== null && result !== undefined)
          resultCache.set(key, result);
        if (FLAGS.perfOverlay) recordWasmCache(name, false, resultCache.size);
        return result;
      };
    },
  });
}
