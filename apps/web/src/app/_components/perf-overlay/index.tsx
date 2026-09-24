import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ClipboardIcon as ClipboardCopy } from "@phosphor-icons/react/dist/csr/Clipboard";
import { MinusIcon as Minus } from "@phosphor-icons/react/dist/csr/Minus";
import { PauseIcon as Pause } from "@phosphor-icons/react/dist/csr/Pause";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/csr/Play";
import { PulseIcon as Activity } from "@phosphor-icons/react/dist/csr/Pulse";
import { SelectionIcon as SquareDashed } from "@phosphor-icons/react/dist/csr/Selection";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Row, Stack } from "~/components/layout";
import { copyText } from "~/lib/clipboard";
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

import { type LiveQueryStats, readLiveQueryStats } from "./use-query-stats";

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const CORNERS: Corner[] = [
  "bottom-left",
  "bottom-right",
  "top-right",
  "top-left",
];
const CORNER_CLASS = {
  "top-left": "top-2 left-2",
  "top-right": "top-2 right-2",
  "bottom-left": "bottom-2 left-2",
  "bottom-right": "bottom-2 right-2",
} satisfies Record<Corner, string>;

type Tab = "WASM" | "Queries" | "Renders" | "Runtime" | "Vitals" | "Slow";
const TABS: Tab[] = ["Slow", "WASM", "Queries", "Renders", "Runtime", "Vitals"];

const ms = (n: number) => `${n.toFixed(1)}ms`;

/**
 * Dev/debug performance overlay. Mounted only when the `perfOverlay` flag is on.
 * Recording happens at the source (wasm.ts, PerfProfiler, useQueryStats); this
 * just starts the runtime collectors and polls a snapshot every 500ms.
 */
export function PerfOverlay() {
  const [corner, setCorner] = useState<Corner>("bottom-left");
  const [minimized, setMinimized] = useState(false);
  const [tab, setTab] = useState<Tab>("Slow");
  const [paused, setPausedState] = useState(false);
  const [snap, setSnap] = useState<PerfSnapshot>(() => snapshot());
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveQueryStats>(() =>
    readLiveQueryStats(queryClient),
  );
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
    if (await copyText(json)) {
      toast.success("Perf report copied as JSON");
      return;
    }
    // A third tier the shared helper doesn't have, and shouldn't: when both
    // clipboard paths are blocked, the report is still recoverable because
    // this surface has a console to dump it to.
    console.log("[perf] report:\n", json);
    toast.message("Clipboard blocked — perf report logged to console");
  };

  if (minimized) {
    return (
      <Row
        as="button"
        type="button"
        align="center"
        gap="snug"
        onClick={() => setMinimized(false)}
        className={cn(
          "fixed z-[60] border border-[var(--border)] bg-card px-2 py-1 font-mono text-xs",
          CORNER_CLASS[corner],
        )}
      >
        <Activity className="size-3 text-primary" />
        {snap.runtime.fps} fps
      </Row>
    );
  }

  return (
    <div
      className={cn(
        "fixed z-[60] flex max-h-[70vh] w-80 flex-col overflow-hidden border border-[var(--border)] bg-card font-mono text-xs",
        CORNER_CLASS[corner],
      )}
    >
      {/* Header */}
      <Row
        align="center"
        gap="xs"
        className="border-b border-border/60 bg-muted/40 px-2 py-1"
      >
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
        <Row align="center" gap="tight" className="ml-auto">
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
        </Row>
      </Row>

      {/* Tabs */}
      <div className="flex border-b border-border/60">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 px-1 py-1 text-2xs tracking-wide uppercase transition-colors",
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
      <div className="flex-1 overflow-y-auto p-1.5" /* tight */>
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

const SLOW_TONE = {
  query: 1,
  mutation: 5,
  wasm: 2,
  render: 4,
} satisfies Record<SlowEvent["kind"], number>;
const SLOW_TAG = {
  query: "qry",
  mutation: "mut",
  wasm: "wasm",
  render: "rndr",
} satisfies Record<SlowEvent["kind"], string>;

/** Chronological log of jank events (≥16ms) across WASM, queries and renders. */
function SlowTab({ snap }: { snap: PerfSnapshot }) {
  const events = snap.slowest;
  if (events.length === 0)
    return <Empty label="No jank (≥16ms) yet — interact or load a page." />;
  const now = performance.now();
  return (
    <table className="w-full">
      <tbody>
        {events.map((e) => (
          <tr
            key={`${e.at}-${e.kind}-${e.label}-${e.ms}`}
            className="border-t border-border/30"
          >
            <td className="py-0.5 pr-1 align-middle" /* tight */>
              <span
                className="text-3xs font-semibold uppercase"
                style={{ color: `var(--chart-${SLOW_TONE[e.kind]})` }}
              >
                {SLOW_TAG[e.kind]}
              </span>
            </td>
            <td className="truncate py-0.5" /* tight */ title={e.label}>
              {e.label}
            </td>
            <td className="pl-1 text-right text-2xs whitespace-nowrap text-muted-foreground">
              {Math.round((now - e.at) / 1000)}s
            </td>
            <td
              className={cn(
                "pl-1 text-right font-semibold whitespace-nowrap",
                e.ms > 100 ? "text-destructive" : "text-warning-ink",
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
    <Stack gap="xs">
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
              <tr key={name} className="border-t border-border/30">
                <td className="truncate py-0.5" /* tight */>
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
    </Stack>
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
    <Stack gap="xs">
      <Row gap="sm" className="px-1 text-2xs">
        <span
          className={cn(
            live.inFlight > 0 ? "text-primary" : "text-muted-foreground",
          )}
        >
          {live.inFlight} in-flight
        </span>
        <span className="text-muted-foreground">{live.total} cached</span>
        {live.mutationsPending > 0 && (
          <span className="text-warning-ink">{live.mutationsPending} mut</span>
        )}
      </Row>
      {rows.length === 0 ? (
        <Empty label="No operations recorded yet." />
      ) : (
        <>
          <table className="w-full">
            <thead className="text-2xs text-muted-foreground">
              <tr className="text-left">
                <th className="font-normal">operation</th>
                <th
                  className="text-right font-normal"
                  title="fetch/reuse/cancel/error"
                >
                  f/r/c/e
                </th>
                <th className="text-right font-normal">avg</th>
                <th className="text-right font-normal">max</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, stat]) => (
                <tr key={key} className="border-t border-border/30">
                  <td
                    className="max-w-36 truncate py-0.5"
                    title={stat.operation}
                  >
                    <span className="mr-1 text-3xs text-muted-foreground uppercase">
                      {stat.transport}
                    </span>
                    {stat.operation}
                    {stat.lastOperationId && (
                      <span
                        className="ml-1 text-3xs text-muted-foreground"
                        title="Most recent operation ID"
                      >
                        {stat.lastOperationId}
                      </span>
                    )}
                    {stat.fanout && (
                      <span className="ml-1 rounded-sm bg-destructive/15 px-1 text-3xs text-destructive">
                        N+1
                      </span>
                    )}
                  </td>
                  <td className="text-right text-2xs whitespace-nowrap">
                    {stat.fetches}/{stat.reuses}/{stat.cancelled}/{stat.errors}
                  </td>
                  <td className="text-right text-muted-foreground">
                    {ms(stat.fetches > 0 ? stat.totalMs / stat.fetches : 0)}
                  </td>
                  <td className="text-right text-muted-foreground">
                    {ms(stat.maxMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-1 pt-1 text-3xs text-muted-foreground">
            Hydrated/cache baselines may predate this browser recorder. H ={" "}
            {rows.reduce((total, [, stat]) => total + stat.hydrated, 0)}.
          </div>
        </>
      )}
      {snap.mutations.length > 0 && (
        <div className="border-t border-border/50 pt-1">
          <div className="px-1 text-2xs font-semibold text-muted-foreground">
            recent mutations
          </div>
          <table className="w-full">
            <tbody>
              {snap.mutations.slice(0, 8).map((mutation) => (
                <tr
                  key={`${mutation.id}-${mutation.at}`}
                  className="border-t border-border/30"
                >
                  <td
                    className="max-w-44 truncate py-0.5"
                    title={mutation.operation}
                  >
                    <span className="mr-1 text-3xs text-muted-foreground uppercase">
                      {mutation.transport}
                    </span>
                    {mutation.operation}
                  </td>
                  <td
                    className={cn(
                      "text-right text-2xs",
                      mutation.outcome === "error" && "text-destructive",
                      mutation.outcome === "cancelled" && "text-warning",
                    )}
                  >
                    {mutation.outcome}
                  </td>
                  <td className="text-right text-muted-foreground">
                    {ms(mutation.durationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Stack>
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
            <tr key={id} className="border-t border-border/30 align-top">
              <td className="py-0.5" /* tight */>
                <Row align="center" gap="xs">
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
                </Row>
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
  const navigation = snap.navigation;
  const commandSearch = snap.commandSearch.records;
  const lastCommandSearch = commandSearch.at(-1);
  return (
    <Stack gap="xs" className="p-1">
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
      <Metric
        label="Navigation avg"
        value={
          navigation.count === 0
            ? "…"
            : ms(navigation.totalMs / navigation.count)
        }
        bad={
          navigation.count > 0 && navigation.totalMs / navigation.count > 1000
        }
      />
      {navigation.last && (
        <Metric
          label={`Last: ${navigation.last.routeId}`}
          value={ms(navigation.last.durationMs)}
          bad={navigation.last.durationMs > 3000}
        />
      )}
      {lastCommandSearch && (
        <Metric
          label={`Command-K ${lastCommandSearch.phase}`}
          value={ms(lastCommandSearch.durationMs)}
          bad={
            lastCommandSearch.phase === "lexical" &&
            lastCommandSearch.durationMs > 400
          }
        />
      )}
    </Stack>
  );
}

function VitalsTab({ snap }: { snap: PerfSnapshot }) {
  const { lcp, inp, cls } = snap.vitals;
  return (
    <Stack gap="xs" className="p-1">
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
    </Stack>
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
    <Row
      align="center"
      justify="between"
      className="rounded bg-muted/40 px-2 py-1"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-semibold", bad && "text-destructive")}>
        {value}
      </span>
    </Row>
  );
}
