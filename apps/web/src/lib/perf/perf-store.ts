/**
 * In-memory performance metrics, accumulated by cheap `record*` calls and read
 * by the perf overlay on a poll interval (so recording never triggers React
 * work). Everything here is opt-in: the WASM/render/query recorders are only
 * invoked when the `perfOverlay` flag is on, and the runtime/vitals collectors
 * are started/stopped by the overlay. See lib/flags + lib/wasm + perf-overlay.
 *
 * `web-vitals` is imported dynamically (browser-only) inside `startCollectors`
 * so this module stays safe to import in the SSR/CF-worker bundle (via wasm.ts).
 */

export interface WasmStat {
  executions: number;
  totalMs: number;
  maxMs: number;
  coldMs: number; // duration of the first (cold) execution
  hits: number;
  misses: number;
  throws: number; // executions that threw (e.g. failed conversions — never cached)
}
export interface SlowEvent {
  kind: "wasm" | "query" | "render";
  label: string;
  ms: number;
  at: number; // performance.now() when recorded
}
export interface RenderStat {
  count: number;
  totalMs: number;
  maxMs: number;
  lastPhase: string;
}
export interface QueryStat {
  fetches: number;
  totalMs: number;
  maxMs: number;
  fanout: boolean;
}
export interface RuntimeStat {
  fps: number;
  longTasks: number;
  heapUsedMB: number | null;
}
export interface VitalsStat {
  lcp: number | null;
  inp: number | null;
  cls: number | null;
}
export interface PerfSnapshot {
  wasm: Record<string, WasmStat>;
  cacheSize: number;
  renders: Record<string, RenderStat>;
  queries: Record<string, QueryStat>;
  runtime: RuntimeStat;
  vitals: VitalsStat;
  slowest: SlowEvent[];
  paused: boolean;
}

const FANOUT_WINDOW_MS = 1000;
const FANOUT_THRESHOLD = 5;
const SLOW_EVENT_MS = 16; // one 60fps frame
const SLOW_LOG_MAX = 40;

const wasm = new Map<string, WasmStat>();
const renders = new Map<string, RenderStat>();
const queries = new Map<string, QueryStat>();
const queryTimestamps = new Map<string, number[]>();
const runtime: RuntimeStat = { fps: 0, longTasks: 0, heapUsedMB: null };
const vitals: VitalsStat = { lcp: null, inp: null, cls: null };
const slowLog: SlowEvent[] = [];
let cacheSize = 0;
let paused = false;

function emptyWasm(): WasmStat {
  return {
    executions: 0,
    totalMs: 0,
    maxMs: 0,
    coldMs: 0,
    hits: 0,
    misses: 0,
    throws: 0,
  };
}

/** Append jank events (≥ one frame) to a bounded chronological ring buffer. */
function recordSlow(kind: SlowEvent["kind"], label: string, ms: number): void {
  if (ms < SLOW_EVENT_MS) return;
  slowLog.push({ kind, label, ms, at: performance.now() });
  if (slowLog.length > SLOW_LOG_MAX) slowLog.shift();
}

/** Record an actual WASM execution (cache miss or non-cacheable method). */
export function recordWasmExec(
  method: string,
  durationMs: number,
  threw = false,
): void {
  if (paused) return;
  const s = wasm.get(method) ?? emptyWasm();
  if (s.executions === 0) s.coldMs = durationMs;
  s.executions += 1;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
  if (threw) s.throws += 1;
  wasm.set(method, s);
  recordSlow("wasm", method, durationMs);
}

export function recordWasmCache(
  method: string,
  hit: boolean,
  size: number,
): void {
  if (paused) return;
  const s = wasm.get(method) ?? emptyWasm();
  if (hit) s.hits += 1;
  else s.misses += 1;
  wasm.set(method, s);
  cacheSize = size;
}

export function recordRender(
  id: string,
  phase: string,
  durationMs: number,
): void {
  if (paused) return;
  const s = renders.get(id) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastPhase: "",
  };
  s.count += 1;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
  s.lastPhase = phase;
  renders.set(id, s);
  recordSlow("render", `${id}:${phase}`, durationMs);
}

export function recordQuery(procedure: string, durationMs: number): void {
  if (paused) return;
  const s = queries.get(procedure) ?? {
    fetches: 0,
    totalMs: 0,
    maxMs: 0,
    fanout: false,
  };
  s.fetches += 1;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
  queries.set(procedure, s);
  const now = performance.now();
  const ts = queryTimestamps.get(procedure) ?? [];
  ts.push(now);
  queryTimestamps.set(procedure, ts);
  recordSlow("query", procedure, durationMs);
}

export function reset(): void {
  wasm.clear();
  renders.clear();
  queries.clear();
  queryTimestamps.clear();
  slowLog.length = 0;
  runtime.longTasks = 0;
  cacheSize = 0;
}

export function setPaused(value: boolean): void {
  paused = value;
}

export function snapshot(): PerfSnapshot {
  const now = performance.now();
  const queriesOut: Record<string, QueryStat> = {};
  for (const [proc, s] of queries) {
    const ts = (queryTimestamps.get(proc) ?? []).filter(
      (t) => now - t < FANOUT_WINDOW_MS,
    );
    queryTimestamps.set(proc, ts);
    queriesOut[proc] = { ...s, fanout: ts.length >= FANOUT_THRESHOLD };
  }
  const mem = (
    performance as Performance & { memory?: { usedJSHeapSize: number } }
  ).memory;
  return {
    wasm: Object.fromEntries(wasm),
    cacheSize,
    renders: Object.fromEntries(renders),
    queries: queriesOut,
    runtime: {
      ...runtime,
      heapUsedMB: mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null,
    },
    vitals: { ...vitals },
    slowest: slowLog.slice().reverse(), // most-recent-first
    paused,
  };
}

// ── Runtime collectors (FPS, long tasks, Web Vitals) ───────────────────────────
let rafId: number | null = null;
let longTaskObserver: PerformanceObserver | null = null;
let frames = 0;
let fpsWindowStart = 0;
let vitalsRegistered = false;

export function startCollectors(): void {
  if (typeof window === "undefined" || rafId !== null) return;

  fpsWindowStart = performance.now();
  frames = 0;
  const tick = () => {
    frames += 1;
    const now = performance.now();
    if (now - fpsWindowStart >= 1000) {
      runtime.fps = Math.round((frames * 1000) / (now - fpsWindowStart));
      frames = 0;
      fpsWindowStart = now;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  try {
    longTaskObserver = new PerformanceObserver((list) => {
      runtime.longTasks += list.getEntries().length;
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {
    // longtask not supported (e.g. Safari) — leave the counter at 0.
  }

  // Web Vitals are page-lifetime listeners; register once, keep updating.
  // Dynamic import keeps the browser-only lib out of the SSR/CF bundle.
  if (!vitalsRegistered) {
    vitalsRegistered = true;
    void import("web-vitals").then(({ onLCP, onINP, onCLS }) => {
      const opts = { reportAllChanges: true };
      onLCP((m) => {
        vitals.lcp = Math.round(m.value);
      }, opts);
      onINP((m) => {
        vitals.inp = Math.round(m.value);
      }, opts);
      onCLS((m) => {
        vitals.cls = Math.round(m.value * 1000) / 1000;
      }, opts);
    });
  }
}

export function stopCollectors(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  longTaskObserver?.disconnect();
  longTaskObserver = null;
}
