import * as asyncHooks from "node:async_hooks";

type WasmMetrics = {
  calls: number;
  failures: number;
  durationMs: number;
  methods: Map<string, number>;
};
type Holder = {
  metrics: WasmMetrics;
  deferred: boolean;
  finish: () => void;
};
// Shared compute also runs in browsers, whose node builtins are stubbed.
const store =
  typeof window === "undefined"
    ? new asyncHooks.AsyncLocalStorage<Holder>()
    : undefined;

/** One aggregate spans all calls, including a streamed response's later work. */
export async function withWasmMetrics<T>(
  report: (metrics: WasmMetrics) => void,
  run: () => Promise<T>,
): Promise<T> {
  if (!store) return run();
  const metrics: WasmMetrics = {
    calls: 0,
    failures: 0,
    durationMs: 0,
    methods: new Map(),
  };
  let finished = false;
  const holder: Holder = {
    metrics,
    deferred: false,
    finish: () => {
      if (finished) return;
      finished = true;
      if (metrics.calls > 0) report(metrics);
    },
  };
  return store.run(holder, async () => {
    try {
      return await run();
    } catch (error) {
      holder.finish();
      throw error;
    } finally {
      if (!holder.deferred) holder.finish();
    }
  });
}

/** Streaming HTTP retains the report until its body completes or is cancelled. */
export function deferWasmMetrics(): () => void {
  const holder = store?.getStore();
  if (!holder) return () => {};
  holder.deferred = true;
  return holder.finish;
}

export function recordWasmMeasurement(
  name: string,
  durationMs: number,
  failed: boolean,
): void {
  const metrics = store?.getStore()?.metrics;
  if (!metrics) return;
  metrics.calls += 1;
  metrics.failures += Number(failed);
  metrics.durationMs += durationMs;
  metrics.methods.set(name, (metrics.methods.get(name) ?? 0) + 1);
}
