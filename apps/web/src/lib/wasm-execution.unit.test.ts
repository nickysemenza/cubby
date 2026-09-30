import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordWasmExec, reset, snapshot } from "~/lib/perf/perf-store";

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
    reset();
    vi.restoreAllMocks();
  });

  it("preserves synchronous results and pure-result caching", () => {
    const value = executeWasm("sync", () => "done", []);

    expect(value).toBe("done");

    const first = wasm.parse_ingredient("7 cachetestunits architecture flour");
    const second = wasm.parse_ingredient("7 cachetestunits architecture flour");

    expect(second).toBe(first);
  });

  it("preserves asynchronous resolution", async () => {
    const pending = deferred<string>();
    const result = executeWasm("async resolve", () => pending.promise, []);

    pending.resolve("done");

    await expect(result).resolves.toBe("done");
  });

  it("preserves asynchronous rejection", async () => {
    const pending = deferred<string>();
    const error = new Error("extraction failed");
    const result = executeWasm("async reject", () => pending.promise, []);

    pending.reject(error);

    await expect(result).rejects.toBe(error);
  });

  it("does not classify async elapsed time as UI blocking", () => {
    recordWasmExec("sync", 20, false, "sync");
    recordWasmExec("async", 40, false, "async");

    expect(snapshot().slowest).toEqual([
      expect.objectContaining({ kind: "wasm", label: "sync", ms: 20 }),
    ]);
  });
});
