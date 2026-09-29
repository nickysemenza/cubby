import { FLAGS } from "~/lib/flags";
import { recordWasmExec } from "~/lib/perf/perf-store";
import { TraceNames, withSynchronousManualTrace } from "~/server/tracing";

/** A synchronous WASM call over one 60fps frame can visibly block the UI. */
const SLOW_WASM_THRESHOLD_MS = 16;

const isStringArgument = <TArgument>(
  arg: TArgument,
): arg is Extract<TArgument, string> => typeof arg === "string";

const isObjectArgument = <TArgument>(
  arg: TArgument,
): arg is Extract<TArgument, object> => arg !== null && typeof arg === "object";

const summarizeArg = <TArgument>(arg: TArgument): string => {
  if (arg instanceof Uint8Array || arg instanceof ArrayBuffer) {
    return `Uint8Array(${arg.byteLength})`;
  }
  if (isStringArgument(arg)) {
    return arg.length > 64 ? `"${arg.slice(0, 61)}…"` : JSON.stringify(arg);
  }
  if (Array.isArray(arg)) return `Array(${arg.length})`;
  if (isObjectArgument(arg)) return "{…}";
  return String(arg);
};

export function executeWasm<TArgs extends unknown[], TResult>(
  name: string,
  method: (...args: TArgs) => Promise<TResult>,
  args: TArgs,
): Promise<TResult>;
export function executeWasm<TArgs extends unknown[], TResult>(
  name: string,
  method: (...args: TArgs) => TResult,
  args: TArgs,
): TResult;
/** Invoke a WASM export while measuring its actual completion for the overlay. */
export function executeWasm<TArgs extends unknown[], TResult>(
  name: string,
  method: (...args: TArgs) => TResult | Promise<TResult>,
  args: TArgs,
): TResult | Promise<TResult> {
  return withSynchronousManualTrace(TraceNames.wasm(name), (span, end) => {
    const start = performance.now();
    let completed = false;
    const complete = (
      threw: boolean,
      executionMode: "sync" | "async",
    ): void => {
      if (completed) return;
      completed = true;
      const durationMs = performance.now() - start;
      if (span.isRecording)
        span.setAttributes({
          "wasm.method": name,
          "wasm.duration_us": Math.round(durationMs * 1000),
          "wasm.execution_mode": executionMode,
          "wasm.threw": threw,
        });
      if (FLAGS.perfOverlay) {
        recordWasmExec(name, durationMs, threw, executionMode);
      }
      if (
        executionMode === "sync" &&
        FLAGS.wasmSlowWarn &&
        durationMs > SLOW_WASM_THRESHOLD_MS
      ) {
        console.warn(
          `[wasm] ${name} took ${durationMs.toFixed(1)}ms`,
          args.map(summarizeArg).join(", "),
        );
      }
      end();
    };

    try {
      const result = method(...args);
      if (result instanceof Promise) {
        const reject = <TError>(error: TError): Promise<never> => {
          span.recordException(error);
          span.setError();
          complete(true, "async");
          return Promise.reject(error);
        };
        return result.then((value) => {
          complete(false, "async");
          return value;
        }, reject);
      }
      complete(false, "sync");
      return result;
    } catch (error) {
      span.recordException(error);
      span.setError();
      complete(true, "sync");
      throw error;
    }
  });
}
