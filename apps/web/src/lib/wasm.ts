/**
 * WASM Module - Loaded at module initialization via top-level await
 *
 * Usage: Import `wasm` and call methods synchronously - works everywhere.
 * Vite handles the top-level await natively.
 */

import { flatten } from "flat";
import { getTracer, TraceNames } from "~/server/tracing";

type WasmType = typeof import("@cubby/recipebridge");

// Load WASM at module initialization (Vite handles top-level await)
const instance: WasmType = await import("@cubby/recipebridge");

/** For tests - now a no-op since WASM loads at module init */
export const ensureWasm = (): Promise<void> => Promise.resolve();

/**
 * WASM module with OpenTelemetry tracing.
 * All methods are synchronous - WASM is guaranteed loaded at module init.
 */
export const wasm = new Proxy(instance, {
  get(target, prop) {
    const method = target[prop as keyof WasmType];
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
