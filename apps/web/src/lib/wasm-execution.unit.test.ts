import { SpanStatusCode, trace } from "@opentelemetry/api";
import { tracing } from "@opentelemetry/sdk-node";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { recordWasmExec, reset, snapshot } from "~/lib/perf/perf-store";

// Exercise the shared-worker case: application tracing may already be loaded.
await import("~/server/tracing");
const exporter = new tracing.InMemorySpanExporter();
const provider = new tracing.BasicTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

const { executeWasm } = await import("./wasm-execution");
const { wasm } = await import("./wasm");

const deferred = <T>() => {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) {
    throw new Error("Promise executor did not initialize synchronously");
  }
  return { promise, reject: rejectPromise, resolve: resolvePromise };
};

describe("WASM execution", () => {
  beforeEach(() => {
    exporter.reset();
    reset();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("finishes synchronous work immediately and preserves pure-result caching", () => {
    const value = executeWasm("sync", () => "done", []);

    expect(value).toBe("done");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      "wasm.execution_mode": "sync",
      "wasm.method": "sync",
      "wasm.threw": false,
    });

    exporter.reset();
    const first = wasm.parse_ingredient("7 cachetestunits architecture flour");
    const second = wasm.parse_ingredient("7 cachetestunits architecture flour");

    expect(second).toBe(first);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("keeps the span open until asynchronous work resolves", async () => {
    const pending = deferred<string>();
    const result = executeWasm("async resolve", () => pending.promise, []);

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    pending.resolve("done");

    await expect(result).resolves.toBe("done");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      "wasm.execution_mode": "async",
      "wasm.method": "async resolve",
      "wasm.threw": false,
    });
  });

  it("records an asynchronous rejection before preserving it", async () => {
    const pending = deferred<string>();
    const error = new Error("extraction failed");
    const result = executeWasm("async reject", () => pending.promise, []);

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    pending.reject(error);

    await expect(result).rejects.toBe(error);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes).toMatchObject({
      "wasm.execution_mode": "async",
      "wasm.method": "async reject",
      "wasm.threw": true,
    });
    expect(span?.events[0]?.name).toBe("exception");
  });

  it("does not classify async elapsed time as UI blocking", () => {
    recordWasmExec("sync", 20, false, "sync");
    recordWasmExec("async", 40, false, "async");

    expect(snapshot().slowest).toEqual([
      expect.objectContaining({ kind: "wasm", label: "sync", ms: 20 }),
    ]);
  });
});
