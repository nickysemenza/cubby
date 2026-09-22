/**
 * In-memory performance metrics, accumulated by cheap `record*` calls and read
 * by the perf overlay on a poll interval (so recording never triggers React
 * work). Query and mutation lifecycle recording is always available so opening
 * the overlay does not erase the history that explains the current cache. The
 * heavier runtime/vitals collectors remain controlled by the overlay.
 *
 * `web-vitals` is imported dynamically (browser-only) inside `startCollectors`
 * so this module stays safe to import in the SSR/CF-worker bundle (via wasm.ts).
 */

interface WasmStat {
  executions: number;
  totalMs: number;
  maxMs: number;
  coldMs: number; // duration of the first (cold) execution
  hits: number;
  misses: number;
  throws: number; // executions that threw (e.g. failed conversions — never cached)
}
export interface SlowEvent {
  kind: "wasm" | "query" | "mutation" | "render";
  label: string;
  ms: number;
  at: number; // performance.now() when recorded
}
interface RenderStat {
  count: number;
  totalMs: number;
  maxMs: number;
  lastPhase: string;
}
export type OperationTransport = "start" | "auth" | "client";
export type OperationOutcome = "success" | "error" | "cancelled";
export type QueryOperationKind = "fetch" | "reuse" | "hydrated";

interface QueryStat {
  lastOperationId?: string;
  operation: string;
  transport: OperationTransport;
  fetches: number;
  reuses: number;
  hydrated: number;
  cancelled: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  fanout: boolean;
}
export interface MutationRecord {
  id: string;
  operation: string;
  transport: OperationTransport;
  entity?: string;
  outcome: OperationOutcome;
  durationMs: number;
  at: number;
}
interface RuntimeStat {
  fps: number;
  longTasks: number;
  heapUsedMB: number | null;
}
interface VitalsStat {
  lcp: number | null;
  inp: number | null;
  cls: number | null;
}
export interface PerfSnapshot {
  wasm: Record<string, WasmStat>;
  cacheSize: number;
  renders: Record<string, RenderStat>;
  queries: Record<string, QueryStat>;
  mutations: MutationRecord[];
  runtime: RuntimeStat;
  vitals: VitalsStat;
  navigation: NavigationStat;
  commandSearch: CommandSearchStat;
  slowest: SlowEvent[];
  paused: boolean;
}

interface NavigationStat {
  count: number;
  totalMs: number;
  maxMs: number;
  pendingShown: number;
  last: { routeId: string; durationMs: number } | null;
  records: NavigationRecord[];
}

interface NavigationRecord {
  routeId: string;
  durationMs: number;
  pendingShown: boolean;
  at: number;
}

export interface CommandSearchRecord {
  phase: "lexical" | "semantic" | "chunk-preload" | "chunk-open";
  durationMs: number;
  resultCount: number;
  scoped: boolean;
  queryLength: number;
  at: number;
}

interface CommandSearchStat {
  records: CommandSearchRecord[];
}

const FANOUT_WINDOW_MS = 1000;
const FANOUT_THRESHOLD = 5;
const SLOW_EVENT_MS = 16; // one 60fps frame
const SLOW_LOG_MAX = 40;
const INTERACTION_LOG_MAX = 50;

const wasm = new Map<string, WasmStat>();
const renders = new Map<string, RenderStat>();
const queries = new Map<string, QueryStat>();
const queryTimestamps = new Map<string, number[]>();
const mutations: MutationRecord[] = [];
const runtime: RuntimeStat = { fps: 0, longTasks: 0, heapUsedMB: null };
const vitals: VitalsStat = { lcp: null, inp: null, cls: null };
const navigation: NavigationStat = {
  count: 0,
  totalMs: 0,
  maxMs: 0,
  pendingShown: 0,
  last: null,
  records: [],
};
const commandSearch: CommandSearchStat = { records: [] };
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
  executionMode: "sync" | "async" = "sync",
): void {
  if (paused) return;
  const s = wasm.get(method) ?? emptyWasm();
  if (s.executions === 0) s.coldMs = durationMs;
  s.executions += 1;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
  if (threw) s.throws += 1;
  wasm.set(method, s);
  if (executionMode === "sync") recordSlow("wasm", method, durationMs);
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

const queryStatKey = (transport: OperationTransport, operation: string) =>
  `${transport}:${operation}`;

export function recordQueryOperation(options: {
  id?: string;
  operation: string;
  transport: OperationTransport;
  kind: QueryOperationKind;
  durationMs?: number;
  outcome?: OperationOutcome;
}): void {
  if (paused) return;
  const key = queryStatKey(options.transport, options.operation);
  const s = queries.get(key) ?? {
    operation: options.operation,
    transport: options.transport,
    fetches: 0,
    reuses: 0,
    hydrated: 0,
    cancelled: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    fanout: false,
  };
  if (options.id) s.lastOperationId = options.id;
  if (options.kind === "reuse") s.reuses += 1;
  else if (options.kind === "hydrated") s.hydrated += 1;
  else {
    const durationMs = options.durationMs ?? 0;
    s.fetches += 1;
    s.totalMs += durationMs;
    s.maxMs = Math.max(s.maxMs, durationMs);
    if (options.outcome === "cancelled") s.cancelled += 1;
    if (options.outcome === "error") s.errors += 1;
    const now = performance.now();
    const timestamps = (queryTimestamps.get(key) ?? []).filter(
      (timestamp) => now - timestamp < FANOUT_WINDOW_MS,
    );
    timestamps.push(now);
    queryTimestamps.set(key, timestamps);
    recordSlow("query", options.operation, durationMs);
  }
  queries.set(key, s);
}

export function recordMutation(record: Omit<MutationRecord, "at">): void {
  if (paused) return;
  mutations.push({ ...record, at: performance.now() });
  if (mutations.length > INTERACTION_LOG_MAX) mutations.shift();
  recordSlow("mutation", record.operation, record.durationMs);
}

/** Record router start → first animation frame after the destination rendered. */
export function recordNavigation({
  routeId,
  durationMs,
  pendingShown,
}: {
  routeId: string;
  durationMs: number;
  pendingShown: boolean;
}): void {
  if (paused) return;
  navigation.count += 1;
  navigation.totalMs += durationMs;
  navigation.maxMs = Math.max(navigation.maxMs, durationMs);
  if (pendingShown) navigation.pendingShown += 1;
  navigation.last = { routeId, durationMs };
  navigation.records.push({
    routeId,
    durationMs,
    pendingShown,
    at: performance.now(),
  });
  if (navigation.records.length > INTERACTION_LOG_MAX)
    navigation.records.shift();
}

/** Record one bounded Command-K network or chunk timing sample. */
export function recordCommandSearch(
  record: Omit<CommandSearchRecord, "at">,
): void {
  if (paused) return;
  commandSearch.records.push({ ...record, at: performance.now() });
  if (commandSearch.records.length > INTERACTION_LOG_MAX) {
    commandSearch.records.shift();
  }
}

export function reset(): void {
  wasm.clear();
  renders.clear();
  queries.clear();
  queryTimestamps.clear();
  mutations.length = 0;
  slowLog.length = 0;
  runtime.longTasks = 0;
  cacheSize = 0;
  navigation.count = 0;
  navigation.totalMs = 0;
  navigation.maxMs = 0;
  navigation.pendingShown = 0;
  navigation.last = null;
  navigation.records.length = 0;
  commandSearch.records.length = 0;
}

export function setPaused(value: boolean): void {
  paused = value;
}

interface PerformanceMemoryTelemetry extends Performance {
  memory: { usedJSHeapSize: number };
}

function hasMemoryTelemetry(
  value: Performance,
): value is PerformanceMemoryTelemetry {
  return "memory" in value;
}

export function snapshot(): PerfSnapshot {
  const now = performance.now();
  const queriesOut: Record<string, QueryStat> = {};
  for (const [key, s] of queries) {
    const ts = (queryTimestamps.get(key) ?? []).filter(
      (t) => now - t < FANOUT_WINDOW_MS,
    );
    queryTimestamps.set(key, ts);
    queriesOut[key] = { ...s, fanout: ts.length >= FANOUT_THRESHOLD };
  }
  const mem = hasMemoryTelemetry(performance) ? performance.memory : undefined;
  return {
    wasm: Object.fromEntries(wasm),
    cacheSize,
    renders: Object.fromEntries(renders),
    queries: queriesOut,
    mutations: [...mutations].reverse(),
    runtime: {
      ...runtime,
      heapUsedMB: mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null,
    },
    vitals: { ...vitals },
    navigation: { ...navigation, records: [...navigation.records] },
    commandSearch: { records: [...commandSearch.records] },
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
  if (globalThis.window === undefined || rafId !== null) return;

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
    // SILENT: longtask not supported (e.g. Safari) — leave the counter at 0;
    // this is self-instrumentation and must never affect the page it measures.
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
