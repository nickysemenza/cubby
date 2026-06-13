import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ClipboardCopy,
  Minus,
  Pause,
  Play,
  RotateCcw,
  SquareDashed,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { setFlag } from "~/lib/flags";
import {
  type PerfSnapshot,
  reset,
  type SlowEvent,
  setPaused,
  snapshot,
  startCollectors,
  stopCollectors,
} from "~/lib/perf/perf-store";
import { cn } from "~/lib/utils";
import {
  type LiveQueryStats,
  readLiveQueryStats,
  useQueryTimingRecorder,
} from "./use-query-stats";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const CORNERS: Corner[] = [
  "bottom-left",
  "bottom-right",
  "top-right",
  "top-left",
];
const CORNER_CLASS: Record<Corner, string> = {
  "top-left": "top-2 left-2",
  "top-right": "top-2 right-2",
  "bottom-left": "bottom-2 left-2",
  "bottom-right": "bottom-2 right-2",
};

type Tab = "WASM" | "Queries" | "Renders" | "Runtime" | "Vitals" | "Slow";
const TABS: Tab[] = ["Slow", "WASM", "Queries", "Renders", "Runtime", "Vitals"];

const ms = (n: number) => `${n.toFixed(1)}ms`;

/**
 * Dev/debug performance overlay. Mounted only when the `perfOverlay` flag is on.
 * Recording happens at the source (wasm.ts, PerfProfiler, useQueryStats); this
 * just starts the runtime collectors and polls a snapshot every 500ms.
 */
export function PerfOverlay() {
  const [corner, setCorner] = useLocalStorage<Corner>(
    "perfOverlayCorner",
    "bottom-left",
  );
  const [minimized, setMinimized] = useLocalStorage("perfOverlayMin", false);
  const [tab, setTab] = useState<Tab>("Slow");
  const [paused, setPausedState] = useState(false);
  const [snap, setSnap] = useState<PerfSnapshot>(() => snapshot());
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveQueryStats>(() =>
    readLiveQueryStats(queryClient),
  );
  useQueryTimingRecorder();

  useEffect(() => {
    startCollectors();
    return () => stopCollectors();
  }, []);

  // Single poll refreshes both the perf snapshot and the live query counts, so
  // nothing calls setState inside React Query's notify cascade (which would warn
  // about updating other components mid-render).
  useEffect(() => {
    const id = setInterval(() => {
      setSnap(snapshot());
      setLive(readLiveQueryStats(queryClient));
    }, 500);
    return () => clearInterval(id);
  }, [queryClient]);

  const cycleCorner = () =>
    setCorner(CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length]!);
  const togglePause = () => {
    const next = !paused;
    setPausedState(next);
    setPaused(next);
  };

  const copyReport = async () => {
    const report = {
      capturedAt: new Date().toISOString(),
      url: window.location.pathname,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      live,
      ...snapshot(),
    };
    const json = JSON.stringify(report, null, 2);
    // Modern clipboard (needs a secure context + user gesture)…
    try {
      await navigator.clipboard.writeText(json);
      toast.success("Perf report copied as JSON");
      return;
    } catch {
      // …fall back to the legacy execCommand path…
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = json;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) {
        toast.success("Perf report copied as JSON");
        return;
      }
    } catch {
      // …finally guarantee the data is recoverable via the console.
    }
    // eslint-disable-next-line no-console
    console.log("[perf] report:\n", json);
    toast.message("Clipboard blocked — perf report logged to console");
  };

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className={cn(
          "fixed z-[60] flex items-center gap-1.5 rounded-md border border-[var(--border-chunky)] bg-card px-2 py-1 font-mono text-xs shadow-[var(--shadow-chunky)]",
          CORNER_CLASS[corner],
        )}
      >
        <Activity className="size-3 text-primary" />
        {snap.runtime.fps} fps
      </button>
    );
  }

  return (
    <div
      className={cn(
        "fixed z-[60] flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-lg border border-[var(--border-chunky)] bg-card font-mono text-xs shadow-[var(--shadow-chunky-lg)]",
        CORNER_CLASS[corner],
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1 border-border/60 border-b bg-muted/40 px-2 py-1">
        <Activity className="size-3 text-primary" />
        <span className="font-semibold">perf</span>
        <span className="text-muted-foreground">·</span>
        <span
          className={cn(
            snap.runtime.fps < 30
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {snap.runtime.fps}fps
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn title="Copy report as JSON" onClick={copyReport}>
            <ClipboardCopy className="size-3" />
          </IconBtn>
          <IconBtn title={paused ? "Resume" : "Pause"} onClick={togglePause}>
            {paused ? (
              <Play className="size-3" />
            ) : (
              <Pause className="size-3" />
            )}
          </IconBtn>
          <IconBtn title="Reset" onClick={reset}>
            <RotateCcw className="size-3" />
          </IconBtn>
          <IconBtn title="Move" onClick={cycleCorner}>
            <SquareDashed className="size-3" />
          </IconBtn>
          <IconBtn title="Minimize" onClick={() => setMinimized(true)}>
            <Minus className="size-3" />
          </IconBtn>
          <IconBtn title="Close" onClick={() => setFlag("perfOverlay", false)}>
            <X className="size-3" />
          </IconBtn>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-border/60 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 px-1 py-1 text-2xs uppercase tracking-wide transition-colors",
              tab === t
                ? "bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {tab === "Slow" && <SlowTab snap={snap} />}
        {tab === "WASM" && <WasmTab snap={snap} />}
        {tab === "Queries" && <QueriesTab snap={snap} live={live} />}
        {tab === "Renders" && <RendersTab snap={snap} />}
        {tab === "Runtime" && <RuntimeTab snap={snap} />}
        {tab === "Vitals" && <VitalsTab snap={snap} />}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="p-2 text-center text-muted-foreground">{label}</div>;
}

function Bar({ pct, tone = 1 }: { pct: number; tone?: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, pct)}%`,
          backgroundColor: `var(--chart-${tone})`,
        }}
      />
    </div>
  );
}

const SLOW_TONE: Record<SlowEvent["kind"], number> = {
  query: 1,
  wasm: 2,
  render: 4,
};
const SLOW_TAG: Record<SlowEvent["kind"], string> = {
  query: "qry",
  wasm: "wasm",
  render: "rndr",
};

/** Chronological log of jank events (≥16ms) across WASM, queries and renders. */
function SlowTab({ snap }: { snap: PerfSnapshot }) {
  const events = snap.slowest;
  if (events.length === 0)
    return <Empty label="No jank (≥16ms) yet — interact or load a page." />;
  const now = performance.now();
  return (
    <table className="w-full">
      <tbody>
        {events.map((e, i) => (
          // Composite key: `at` alone collides for events in the same tick.
          <tr key={`${e.at}-${i}`} className="border-border/30 border-t">
            <td className="py-0.5 pr-1 align-middle">
              <span
                className="font-semibold text-3xs uppercase"
                style={{ color: `var(--chart-${SLOW_TONE[e.kind]})` }}
              >
                {SLOW_TAG[e.kind]}
              </span>
            </td>
            <td className="truncate py-0.5" title={e.label}>
              {e.label}
            </td>
            <td className="whitespace-nowrap pl-1 text-right text-2xs text-muted-foreground">
              {Math.round((now - e.at) / 1000)}s
            </td>
            <td
              className={cn(
                "whitespace-nowrap pl-1 text-right font-semibold",
                e.ms > 100 ? "text-destructive" : "text-amber-600",
              )}
            >
              {ms(e.ms)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WasmTab({ snap }: { snap: PerfSnapshot }) {
  const rows = Object.entries(snap.wasm).sort(
    (a, b) => b[1].executions - a[1].executions,
  );
  if (rows.length === 0)
    return <Empty label="No WASM calls yet — load a recipe." />;
  return (
    <div className="space-y-1">
      <div className="px-1 text-2xs text-muted-foreground">
        cache: {snap.cacheSize} entries
      </div>
      <table className="w-full">
        <thead className="text-2xs text-muted-foreground">
          <tr className="text-left">
            <th className="font-normal">method</th>
            <th className="text-right font-normal">calls</th>
            <th className="text-right font-normal">avg</th>
            <th className="text-right font-normal">max</th>
            <th className="text-right font-normal">hit%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, s]) => {
            const lookups = s.hits + s.misses;
            const hitPct = lookups > 0 ? (s.hits / lookups) * 100 : null;
            const avg = s.executions > 0 ? s.totalMs / s.executions : 0;
            return (
              <tr key={name} className="border-border/30 border-t">
                <td className="truncate py-0.5">
                  {name}
                  {s.throws > 0 && (
                    <span
                      className="ml-1 text-3xs text-destructive"
                      title={`${s.throws} executions threw (uncached, re-run each call)`}
                    >
                      ⚠{s.throws}
                    </span>
                  )}
                </td>
                <td className="text-right">{s.executions}</td>
                <td className="text-right text-muted-foreground">{ms(avg)}</td>
                <td
                  className={cn(
                    "text-right",
                    s.maxMs > 16 ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {ms(s.maxMs)}
                </td>
                <td className="text-right">
                  {hitPct === null ? "—" : `${hitPct.toFixed(0)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QueriesTab({
  snap,
  live,
}: {
  snap: PerfSnapshot;
  live: LiveQueryStats;
}) {
  const rows = Object.entries(snap.queries).sort(
    (a, b) => b[1].fetches - a[1].fetches,
  );
  return (
    <div className="space-y-1">
      <div className="flex gap-2 px-1 text-2xs">
        <span
          className={cn(
            live.inFlight > 0 ? "text-primary" : "text-muted-foreground",
          )}
        >
          {live.inFlight} in-flight
        </span>
        <span className="text-muted-foreground">{live.total} cached</span>
        {live.mutationsPending > 0 && (
          <span className="text-amber-600">{live.mutationsPending} mut</span>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty label="No fetches recorded yet." />
      ) : (
        <table className="w-full">
          <thead className="text-2xs text-muted-foreground">
            <tr className="text-left">
              <th className="font-normal">procedure</th>
              <th className="text-right font-normal">n</th>
              <th className="text-right font-normal">avg</th>
              <th className="text-right font-normal">max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([proc, s]) => (
              <tr key={proc} className="border-border/30 border-t">
                <td className="truncate py-0.5">
                  {proc}
                  {s.fanout && (
                    <span className="ml-1 rounded-sm bg-destructive/15 px-1 text-3xs text-destructive">
                      N+1
                    </span>
                  )}
                </td>
                <td className="text-right">{s.fetches}</td>
                <td className="text-right text-muted-foreground">
                  {ms(s.fetches > 0 ? s.totalMs / s.fetches : 0)}
                </td>
                <td className="text-right text-muted-foreground">
                  {ms(s.maxMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RendersTab({ snap }: { snap: PerfSnapshot }) {
  const rows = Object.entries(snap.renders).sort(
    (a, b) => b[1].count - a[1].count,
  );
  // React <Profiler> is a no-op in the production build, so renders are dev-only.
  const caveat = import.meta.env.DEV
    ? "dev build · render times ~2–4× prod"
    : "Renders are only captured in dev builds.";
  if (rows.length === 0) {
    return (
      <Empty
        label={
          import.meta.env.DEV
            ? "No profiled renders yet — load a page."
            : caveat
        }
      />
    );
  }
  const maxCount = rows[0]![1].count;
  return (
    <div>
      <table className="w-full">
        <thead className="text-2xs text-muted-foreground">
          <tr className="text-left">
            <th className="font-normal">component</th>
            <th className="text-right font-normal">renders</th>
            <th className="text-right font-normal">avg</th>
            <th className="text-right font-normal">max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, s]) => (
            <tr key={id} className="border-border/30 border-t align-top">
              <td className="py-0.5">
                <div className="flex items-center gap-1">
                  <span className="truncate">{id}</span>
                  {s.lastPhase && (
                    <span
                      className={cn(
                        "shrink-0 rounded-sm px-1 text-3xs",
                        s.lastPhase === "nested-update"
                          ? "bg-destructive/15 text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {s.lastPhase}
                    </span>
                  )}
                </div>
                <Bar
                  pct={(s.count / maxCount) * 100}
                  tone={s.count > 10 ? 4 : 3}
                />
              </td>
              <td className="text-right font-semibold">{s.count}</td>
              <td className="text-right text-muted-foreground">
                {ms(s.count > 0 ? s.totalMs / s.count : 0)}
              </td>
              <td className="text-right text-muted-foreground">
                {ms(s.maxMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-1 pt-1 text-3xs text-muted-foreground">{caveat}</div>
    </div>
  );
}

function RuntimeTab({ snap }: { snap: PerfSnapshot }) {
  const { fps, longTasks, heapUsedMB } = snap.runtime;
  return (
    <div className="space-y-1 p-1">
      <Metric label="FPS" value={String(fps)} bad={fps < 30} />
      <Metric
        label="Long tasks"
        value={String(longTasks)}
        bad={longTasks > 0}
      />
      <Metric
        label="JS heap"
        value={heapUsedMB === null ? "n/a" : `${heapUsedMB} MB`}
      />
    </div>
  );
}

function VitalsTab({ snap }: { snap: PerfSnapshot }) {
  const { lcp, inp, cls } = snap.vitals;
  return (
    <div className="space-y-1 p-1">
      <Metric
        label="LCP"
        value={lcp === null ? "…" : `${lcp}ms`}
        bad={lcp !== null && lcp > 2500}
      />
      <Metric
        label="INP"
        value={inp === null ? "…" : `${inp}ms`}
        bad={inp !== null && inp > 200}
      />
      <Metric
        label="CLS"
        value={cls === null ? "…" : cls.toFixed(3)}
        bad={cls !== null && cls > 0.1}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  bad,
}: {
  label: string;
  value: string;
  bad?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded bg-muted/40 px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-semibold", bad && "text-destructive")}>
        {value}
      </span>
    </div>
  );
}
