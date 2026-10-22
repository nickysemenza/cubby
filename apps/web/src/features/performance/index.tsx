import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ClipboardIcon } from "@phosphor-icons/react/dist/csr/Clipboard";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { SelectionIcon } from "@phosphor-icons/react/dist/csr/Selection";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

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
import { Row, Stack } from "~/ui/layout";
import { StaticTable } from "~/ui/primitives/static-table";

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
        <PulseIcon className="size-3 text-primary" />
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
        <PulseIcon className="size-3 text-primary" />
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
            <ClipboardIcon className="size-3" />
          </IconBtn>
          <IconBtn title={paused ? "Resume" : "Pause"} onClick={togglePause}>
            {paused ? (
              <PlayIcon className="size-3" />
            ) : (
              <PauseIcon className="size-3" />
            )}
          </IconBtn>
          <IconBtn title="Reset" onClick={reset}>
            <ArrowCounterClockwiseIcon className="size-3" />
          </IconBtn>
          <IconBtn title="Move" onClick={cycleCorner}>
            <SelectionIcon className="size-3" />
          </IconBtn>
          <IconBtn title="Minimize" onClick={() => setMinimized(true)}>
            <MinusIcon className="size-3" />
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
              "flex-1 px-1 py-1 text-xs font-medium transition-colors",
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
    <StaticTable
      className="w-full table-auto"
      rows={events}
      rowKey={(e) => `${e.at}-${e.kind}-${e.label}-${e.ms}`}
      hideHeader
      rowClassName={() => "border-t border-border/30"}
      columns={[
        {
          id: "column-0",
          header: null,
          cellClassName: "py-0.5 pr-1 align-middle",
          cell: (e) => (
            <span
              className="text-3xs font-semibold"
              style={{ color: `var(--chart-${SLOW_TONE[e.kind]})` }}
            >
              {SLOW_TAG[e.kind]}
            </span>
          ),
        },
        {
          id: "column-1",
          header: null,
          cellProps: (e) => ({ className: "truncate py-0.5", title: e.label }),
          cell: (e) => e.label,
        },
        {
          id: "column-2",
          header: null,
          cellClassName:
            "pl-1 text-right text-2xs whitespace-nowrap text-muted-foreground",
          cell: (e) => <>{Math.round((now - e.at) / 1000)}s</>,
        },
        {
          id: "column-3",
          header: null,
          cellProps: (e) => ({
            className: cn(
              "pl-1 text-right font-semibold whitespace-nowrap",
              e.ms > 100 ? "text-destructive" : "text-warning-ink",
            ),
          }),
          cell: (e) => ms(e.ms),
        },
      ]}
    />
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
      <StaticTable
        className="w-full table-auto"
        rows={rows}
        rowKey={([name]) => name}
        rowClassName={() => "border-t border-border/30"}
        columns={[
          {
            id: "column-0",
            header: "method",
            headClassName: "font-normal",
            cellClassName: "truncate py-0.5",
            cell: ([name, s]) => (
              <>
                {name}
                {s.throws > 0 && (
                  <span
                    className="ml-1 text-3xs text-destructive"
                    title={`${s.throws} executions threw (uncached, re-run each call)`}
                  >
                    ⚠{s.throws}
                  </span>
                )}
              </>
            ),
          },
          {
            id: "column-1",
            header: "calls",
            headClassName: "text-right font-normal",
            cellClassName: "text-right",
            cell: ([, s]) => s.executions,
          },
          {
            id: "column-2",
            header: "avg",
            headClassName: "text-right font-normal",
            cellClassName: "text-right text-muted-foreground",
            cell: ([, s]) => {
              const avg = s.executions > 0 ? s.totalMs / s.executions : 0;
              return ms(avg);
            },
          },
          {
            id: "column-3",
            header: "max",
            headClassName: "text-right font-normal",
            cellProps: ([, s]) => ({
              className: cn(
                "text-right",
                s.maxMs > 16 ? "text-destructive" : "text-muted-foreground",
              ),
            }),
            cell: ([, s]) => ms(s.maxMs),
          },
          {
            id: "column-4",
            header: "hit%",
            headClassName: "text-right font-normal",
            cellClassName: "text-right",
            cell: ([, s]) => {
              const lookups = s.hits + s.misses;
              const hitPct = lookups > 0 ? (s.hits / lookups) * 100 : null;
              return hitPct === null ? "—" : `${hitPct.toFixed(0)}%`;
            },
          },
        ]}
      />
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
          <StaticTable
            className="w-full table-auto"
            rows={rows}
            rowKey={([key]) => key}
            rowClassName={() => "border-t border-border/30"}
            columns={[
              {
                id: "column-0",
                header: "operation",
                headClassName: "font-normal",
                cellProps: ([, stat]) => ({
                  className: "max-w-36 truncate py-0.5",
                  title: stat.operation,
                }),
                cell: ([, stat]) => (
                  <>
                    <span className="mr-1 text-3xs font-medium text-muted-foreground">
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
                  </>
                ),
              },
              {
                id: "column-1",
                header: "f/r/c/e",
                headProps: {
                  className: "text-right font-normal",
                  title: "fetch/reuse/cancel/error",
                },
                cellClassName: "text-right text-2xs whitespace-nowrap",
                cell: ([, stat]) => (
                  <>
                    {stat.fetches}/{stat.reuses}/{stat.cancelled}/{stat.errors}
                  </>
                ),
              },
              {
                id: "column-2",
                header: "avg",
                headClassName: "text-right font-normal",
                cellClassName: "text-right text-muted-foreground",
                cell: ([, stat]) =>
                  ms(stat.fetches > 0 ? stat.totalMs / stat.fetches : 0),
              },
              {
                id: "column-3",
                header: "max",
                headClassName: "text-right font-normal",
                cellClassName: "text-right text-muted-foreground",
                cell: ([, stat]) => ms(stat.maxMs),
              },
            ]}
          />
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
          <StaticTable
            className="w-full table-auto"
            rows={snap.mutations.slice(0, 8)}
            rowKey={(mutation) => `${mutation.id}-${mutation.at}`}
            hideHeader
            rowClassName={() => "border-t border-border/30"}
            columns={[
              {
                id: "column-0",
                header: null,
                cellProps: (mutation) => ({
                  className: "max-w-44 truncate py-0.5",
                  title: mutation.operation,
                }),
                cell: (mutation) => (
                  <>
                    <span className="mr-1 text-3xs font-medium text-muted-foreground">
                      {mutation.transport}
                    </span>
                    {mutation.operation}
                  </>
                ),
              },
              {
                id: "column-1",
                header: null,
                cellProps: (mutation) => ({
                  className: cn(
                    "text-right text-2xs",
                    mutation.outcome === "error" && "text-destructive",
                    mutation.outcome === "cancelled" && "text-warning",
                  ),
                }),
                cell: (mutation) => mutation.outcome,
              },
              {
                id: "column-2",
                header: null,
                cellClassName: "text-right text-muted-foreground",
                cell: (mutation) => ms(mutation.durationMs),
              },
            ]}
          />
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
      <StaticTable
        className="w-full table-auto"
        rows={rows}
        rowKey={([id]) => id}
        rowClassName={() => "border-t border-border/30 align-top"}
        columns={[
          {
            id: "column-0",
            header: "component",
            headClassName: "font-normal",
            cellClassName: "py-0.5",
            cell: ([id, s]) => (
              <>
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
              </>
            ),
          },
          {
            id: "column-1",
            header: "renders",
            headClassName: "text-right font-normal",
            cellClassName: "text-right font-semibold",
            cell: ([, s]) => s.count,
          },
          {
            id: "column-2",
            header: "avg",
            headClassName: "text-right font-normal",
            cellClassName: "text-right text-muted-foreground",
            cell: ([, s]) => ms(s.count > 0 ? s.totalMs / s.count : 0),
          },
          {
            id: "column-3",
            header: "max",
            headClassName: "text-right font-normal",
            cellClassName: "text-right text-muted-foreground",
            cell: ([, s]) => ms(s.maxMs),
          },
        ]}
      />
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
