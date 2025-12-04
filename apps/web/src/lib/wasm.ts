/**
 * WASM Module Singleton
 *
 * This module provides access to the WASM instance.
 *
 * All utility functions that use WASM are async and use wasmServer internally,
 * so they work in both client and server contexts:
 *   import { unitMappingsFromFood } from "~/schemas/unit-mapping-utils";
 *   const mappings = await unitMappingsFromFood(food);
 *
 * For direct WASM calls:
 * - Client-side: use `wasm` (sync, guaranteed by WasmContextProvider)
 * - Server-side: use `wasmServer` (async, auto-initializing)
 *
 * For initialization:
 * - Use `ensureWasm()` - safe to call multiple times, handles lazy loading
 */

import { flatten } from "flat";
import { getTracer, TraceNames } from "~/server/tracing";

type WasmType = typeof import("@recipehub/recipebridge");

let instance: WasmType | null = null;
let initPromise: Promise<WasmType> | null = null;

/**
 * Ensures WASM is initialized. Safe to call multiple times.
 * Use this in WasmContextProvider and tests.
 */
export async function ensureWasm(): Promise<void> {
  if (instance) return;
  if (!initPromise) {
    initPromise = import("@recipehub/recipebridge").then((w) => {
      instance = w;
      return w;
    });
  }
  await initPromise;
}

/**
 * Proxy that forwards all WASM method calls (client-side).
 * Throws if accessed before initialization (shouldn't happen due to WasmContextProvider).
 */
export const wasm = new Proxy({} as WasmType, {
  get(_, prop) {
    if (!instance) throw new Error("WASM not initialized");
    const method = instance[prop as keyof WasmType];
    if (typeof method === "function") {
      return (...args: unknown[]) => {
        const tracer = getTracer();
        const name = String(prop);
        return tracer.startActiveSpan(TraceNames.wasm(name), (span) => {
          const start = performance.now();
          try {
            return (method as (...args: unknown[]) => unknown)(...args);
          } finally {
            const μs = ((performance.now() - start) * 1000).toFixed(0);
            span.setAttributes({
              "wasm.method": name,
              "wasm.duration_us": Number(μs),
              data: flatten(args),
            });
            span.end();
          }
        });
      };
    }
    return method;
  },
});

// Type that makes all WASM methods return Promises
type AsyncWasm = {
  [K in keyof WasmType]: WasmType[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : Promise<WasmType[K]>;
};

/**
 * Server-side proxy - every method call auto-initializes WASM.
 * Use this instead of `wasm` in server-side code.
 */
export const wasmServer = new Proxy({} as AsyncWasm, {
  get(_, prop) {
    return async (...args: unknown[]) => {
      await ensureWasm();
      const method = wasm[prop as keyof WasmType];
      if (typeof method === "function") {
        return (method as (...args: unknown[]) => unknown)(...args);
      }
      return method;
    };
  },
});
