/**
 * Shared, presentational Gantt renderer — the single chart body behind both
 * `PortfolioGantt` (surface A, the projects dashboard) and `ProjectGantt`
 * (surface B, a project's detail page). It owns geometry, paint order, and
 * interaction; it owns no data. Rows come pre-flattened from `gantt-model.ts`,
 * the visible window is controlled by the caller, and the name cell is a
 * caller-supplied render prop so router `<Link>`s stay out of this file.
 *
 * ## Why there is no horizontal scroll container
 *
 * Pan/zoom here is a *domain* transform, not a viewport transform: scrolling
 * or zooming changes the visible `[startDay, endDay]` window, and the SVG is
 * always exactly the container's width. That means the left HTML pane, the
 * HTML tick header, and the SVG track all lay out on the same
 * `ROW_HEIGHT`-tall grid with zero scroll-sync code — rows line up 1:1 by
 * construction. Do not reintroduce an inner `overflow-x` wrapper; it would
 * immediately desynchronise the three panes.
 */

import { uniq } from "es-toolkit";
import {
  ChevronDown,
  ChevronRight,
  GanttChartSquare,
  Link2,
  RotateCcw,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { match } from "ts-pattern";
import { Row } from "~/components/layout";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { getStatusChartColor } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import {
  formatDate,
  PROJECT_STATUS_LABELS,
  TASK_STATUS_LABELS,
} from "../../shared";
import { ChartTooltip } from "../ChartTooltip";
import { ChartEmpty } from "../chart-empty";
import {
  buildTicks,
  fromDayIndex,
  type GanttTick,
  toDayIndex,
  todayPlain,
  weekendBands,
} from "./gantt-date";
import type { DayRange, GanttRow } from "./gantt-model";
import { clampWindow, spanOf } from "./gantt-window";

// ---------------------------------------------------------------------------
// Geometry — the one place row rhythm is defined. The left pane's `h-8` rows,
// the header strip, and the SVG's row bands all derive from these.
// ---------------------------------------------------------------------------

/** Row pitch, in px. Must stay in sync with the left pane's `h-8`. */
const ROW_HEIGHT = 32;
/** Tick-header strip height, in px — also the left pane's spacer height. */
const HEADER_HEIGHT = 24;
/** Fixed width of the left (name) pane, in px. */
const NAME_PANE_WIDTH = 240;
/** Left padding of a depth-0 name cell, in px. */
const NAME_PANE_INSET = 8;
/** Extra left padding per depth level, in px. */
const INDENT_PER_DEPTH = 12;

const PROJECT_BAR_HEIGHT = 18;
const TASK_BAR_HEIGHT = 14;
/** A 1-day task must still be visible at any zoom level. */
const MIN_BAR_WIDTH = 4;
/** Envelope whisker end-cap half-height, in px. */
const CAP_HALF_HEIGHT = 5;

/** A pre-window tick's label is only pinned at x=0 if it has this much room. */
const PINNED_LABEL_MIN_ROOM = 48;

const ZOOM_STEP = 1.15;

const NO_EDGES: ReadonlyArray<readonly [string, string]> = [];
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GanttChartProps {
  /** Pre-flattened rows from `buildPortfolioRows` / `buildProjectRows`. */
  rows: GanttRow[];
  /** Controlled visible day window. */
  window: DayRange;
  onWindowChange: (next: DayRange) => void;
  /** Full data extent — clamps zoom-out and seeds the Reset target. */
  extent: DayRange | null;
  /**
   * The window Reset returns to. Falls back to `extent` (then to the current
   * window) when omitted; the Reset button only appears once the live window
   * has drifted from it.
   */
  defaultWindow?: DayRange;
  onToggleExpand: (id: string) => void;
  /** Renders the row's name cell — lets callers supply a router `<Link>`. */
  renderName?: (row: GanttRow) => ReactNode;
  /** Chain highlight (surface B): ids on the critical chain. */
  chainIds?: ReadonlySet<string>;
  /** Elbow connectors for these blocker -> blocked edges (surface B only). */
  edges?: ReadonlyArray<readonly [string, string]>;
  emptyMessage?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sameWindow(a: DayRange, b: DayRange): boolean {
  return a.startDay === b.startDay && a.endDay === b.endDay;
}

/**
 * Fraction of the row that reads as complete. Projects carry a real rollup;
 * tasks only have a status, so `in_progress` renders as a half-filled bar
 * (purely presentational — there is no per-task progress in the model).
 */
function progressOf(row: GanttRow): number {
  return match(row)
    .with({ kind: "project" }, (r) => r.progress)
    .with({ kind: "task" }, (r) =>
      r.status === "done" ? 1 : r.status === "in_progress" ? 0.5 : 0,
    )
    .with({ kind: "group" }, () => 0)
    .exhaustive();
}

function statusLabelOf(row: GanttRow): string | null {
  return match(row)
    .with({ kind: "project" }, (r) => PROJECT_STATUS_LABELS[r.status])
    .with({ kind: "task" }, (r) => TASK_STATUS_LABELS[r.status])
    .with({ kind: "group" }, () => null)
    .exhaustive();
}

/**
 * The row's bar in day space. `endDay: null` means "open ended" — draw to the
 * window's right edge. `null` means the row has no bar at all.
 */
function barRangeOf(
  row: GanttRow,
): { startDay: number; endDay: number | null } | null {
  return match(row)
    .with({ kind: "task" }, (r) => ({ startDay: r.startDay, endDay: r.endDay }))
    .with({ kind: "group" }, () => null)
    .with({ kind: "project" }, (r) => {
      if (r.startDay == null && r.endDay == null) return null;
      if (r.openEnded && r.startDay != null) {
        return { startDay: r.startDay, endDay: null };
      }
      const start = r.startDay ?? r.endDay;
      const end = r.endDay ?? r.startDay;
      if (start == null || end == null) return null;
      return { startDay: start, endDay: end };
    })
    .exhaustive();
}

function dependencyCountOf(row: GanttRow): number {
  return match(row)
    .with({ kind: "group" }, () => 0)
    .otherwise((r) => r.blockedByIds.length + r.blockingIds.length);
}

/**
 * Tick labels are placed at the tick's day, except for the first tick, which
 * `buildTicks` may snap to *before* `window.startDay` (it starts at the
 * containing month/quarter/year boundary). Rather than let that label render
 * off-canvas, it is pinned to x=0 — but only when the next tick leaves it
 * `PINNED_LABEL_MIN_ROOM` px of clearance, otherwise the two labels collide
 * and the pinned one is dropped.
 */
function labelXFor(
  ticks: GanttTick[],
  index: number,
  toX: (day: number) => number,
): number | null {
  const tick = ticks[index];
  if (tick == null) return null;
  const x = toX(tick.day);
  if (x >= 0) return x;
  const next = ticks[index + 1];
  if (next != null && toX(next.day) < PINNED_LABEL_MIN_ROOM) return null;
  return 0;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GanttChart({
  rows,
  window: viewWindow,
  onWindowChange,
  extent,
  defaultWindow,
  onToggleExpand,
  renderName,
  chainIds,
  edges = NO_EDGES,
  emptyMessage = "Nothing scheduled yet.",
}: GanttChartProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width } = useContainerDimensions(trackRef, {
    minHeight: ROW_HEIGHT,
    initialWidth: 640,
    initialHeight: ROW_HEIGHT,
  });
  // Strip non-alphanumerics so the id is safe inside an SVG url(#...) reference.
  const gradientBase = `gantt-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ clientX: 0, startDay: 0 });

  const totalHeight = rows.length * ROW_HEIGHT;
  const spanDays = Math.max(1, spanOf(viewWindow));

  // --- scales -------------------------------------------------------------
  // `toX` is the forward scale (day -> px). `fromX` is its inverse (px -> day)
  // and exists as an explicit seam for the deferred drag-to-reschedule work:
  // a bar drag reads the pointer's px delta back into whole days through it.
  const toX = useCallback(
    (day: number) => ((day - viewWindow.startDay) / spanDays) * width,
    [viewWindow.startDay, spanDays, width],
  );
  const fromX = useCallback(
    (px: number) => viewWindow.startDay + (px / Math.max(1, width)) * spanDays,
    [viewWindow.startDay, spanDays, width],
  );

  const ticks = useMemo(
    () => buildTicks(viewWindow.startDay, viewWindow.endDay),
    [viewWindow.startDay, viewWindow.endDay],
  );
  const weekends = useMemo(
    () => weekendBands(viewWindow.startDay, viewWindow.endDay),
    [viewWindow.startDay, viewWindow.endDay],
  );
  const todayDay = useMemo(() => toDayIndex(todayPlain()), []);

  const rowIndexById = useMemo(
    () => new Map(rows.map((row, i) => [row.id, i])),
    [rows],
  );
  const rowById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  );

  /** Undirected adjacency over the *supplied* chain edges only. */
  const edgeAdjacency = useMemo(() => {
    const map = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = map.get(a);
      if (list == null) map.set(a, [b]);
      else list.push(b);
    };
    for (const [from, to] of edges) {
      link(from, to);
      link(to, from);
    }
    return map;
  }, [edges]);

  /**
   * The hovered row plus everything visually linked to it: its direct
   * dependency neighbours from the row model, and — where the caller supplied
   * chain `edges` — every transitive ancestor and descendant along them (BFS,
   * not just the immediate hops).
   */
  const linkedIds = useMemo<ReadonlySet<string>>(() => {
    if (hoveredId == null) return EMPTY_IDS;
    const set = new Set<string>([hoveredId]);
    const row = rowById.get(hoveredId);
    if (row != null && row.kind !== "group") {
      for (const id of row.blockedByIds) set.add(id);
      for (const id of row.blockingIds) set.add(id);
    }
    const queue = [hoveredId];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current == null) continue;
      for (const neighbor of edgeAdjacency.get(current) ?? []) {
        if (set.has(neighbor)) continue;
        set.add(neighbor);
        queue.push(neighbor);
      }
    }
    return set;
  }, [hoveredId, rowById, edgeAdjacency]);

  const isDimmed = useCallback(
    (row: GanttRow) =>
      hoveredId != null && row.kind !== "group" && !linkedIds.has(row.id),
    [hoveredId, linkedIds],
  );

  // --- open-ended gradients ----------------------------------------------
  // One `<defs>` gradient per distinct status colour in play, keyed off the
  // component's `useId` so several Gantts on a page never collide.
  const openEndedColors = useMemo(
    () =>
      uniq(
        rows
          .filter((row) => row.kind === "project" && row.openEnded)
          .map((row) => getStatusChartColor(statusOf(row))),
      ),
    [rows],
  );
  const gradientIdFor = useCallback(
    (color: string) => {
      const index = openEndedColors.indexOf(color);
      return index < 0 ? null : `${gradientBase}-oe-${index}`;
    },
    [openEndedColors, gradientBase],
  );

  // --- zoom ---------------------------------------------------------------
  // A native, non-passive wheel listener: React's synthetic `onWheel` is
  // registered passively at the root, so `preventDefault()` there is a no-op
  // and the page scrolls out from under the chart.
  const zoomStateRef = useRef({ viewWindow, spanDays, extent, onWindowChange });
  useEffect(() => {
    zoomStateRef.current = { viewWindow, spanDays, extent, onWindowChange };
  }, [viewWindow, spanDays, extent, onWindowChange]);

  useEffect(() => {
    const svg = svgRef.current;
    if (svg == null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = zoomStateRef.current;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return;
      const ratio = (e.clientX - rect.left) / rect.width;
      const anchorDay = state.viewWindow.startDay + ratio * state.spanDays;
      const nextSpan =
        state.spanDays * (e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      const startDay = anchorDay - ratio * nextSpan;
      state.onWindowChange(
        clampWindow(
          { startDay, endDay: startDay + nextSpan - 1 },
          state.extent,
        ),
      );
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // --- pan ----------------------------------------------------------------
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsPanning(true);
      panStart.current = { clientX: e.clientX, startDay: viewWindow.startDay };
    },
    [viewWindow.startDay],
  );

  /** Tooltip anchor, in wrapper-local px. Shared by both panes. */
  const trackPointer = useCallback((e: React.MouseEvent) => {
    const wrapper = wrapperRef.current;
    if (wrapper == null) return;
    const rect = wrapper.getBoundingClientRect();
    setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      trackPointer(e);
      if (!isPanning) return;
      // Pixel delta -> day delta through the inverse scale (see `fromX`).
      const dx = e.clientX - panStart.current.clientX;
      const startDay = panStart.current.startDay - (fromX(dx) - fromX(0));
      onWindowChange(
        clampWindow({ startDay, endDay: startDay + spanDays - 1 }, extent),
      );
    },
    [trackPointer, isPanning, fromX, spanDays, extent, onWindowChange],
  );

  const endPan = useCallback(() => setIsPanning(false), []);

  const resetTarget = defaultWindow ?? extent;
  const canReset = resetTarget != null && !sameWindow(resetTarget, viewWindow);
  const handleReset = useCallback(() => {
    if (resetTarget == null) return;
    onWindowChange(clampWindow(resetTarget, extent));
  }, [resetTarget, extent, onWindowChange]);

  const hoveredRow = hoveredId == null ? null : rowById.get(hoveredId);
  const isEmpty = rows.length === 0;

  // NOTE: the empty state renders *inside* the shell rather than as an early
  // return. `useContainerDimensions` attaches its ResizeObserver in an effect
  // keyed on `[containerRef, minHeight]` — neither of which changes when a ref
  // goes from null to an element — so returning before `trackRef` mounts means
  // the observer is never attached and `width` stays frozen at its initial
  // value for the component's whole life. That's exactly the empty -> populated
  // transition every async-loaded caller hits (the detail page's Gantt renders
  // once with no rows while its query is in flight), and it collapsed every bar
  // to x=0. Keeping the track node mounted from the first render fixes it.
  return (
    <div
      ref={wrapperRef}
      className="relative overflow-hidden rounded-md border"
    >
      {canReset && !isEmpty && (
        <button
          type="button"
          onClick={handleReset}
          className="absolute top-1 right-2 z-10 flex items-center gap-1 rounded-md bg-background/80 px-2 py-1 text-muted-foreground text-xs ring-1 ring-border hover:bg-background hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      )}

      <Row align="stretch">
        {/* Left pane — names. Same ROW_HEIGHT rhythm as the SVG track. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-leave only clears a purely visual hover highlight; the pane's rows are not controls */}
        <div
          className={cn("shrink-0 border-r", isEmpty && "hidden")}
          style={{ width: NAME_PANE_WIDTH }}
          onMouseMove={trackPointer}
          onMouseLeave={() => {
            setHoveredId(null);
            setPointer(null);
          }}
        >
          {/* Spacer matching the tick header, so row 0 aligns across panes. */}
          <div className="border-b" style={{ height: HEADER_HEIGHT }} />
          {rows.map((row) => (
            <NameCell
              key={row.id}
              row={row}
              renderName={renderName}
              onToggleExpand={onToggleExpand}
              onHover={setHoveredId}
              dimmed={isDimmed(row)}
              onChain={chainIds?.has(row.id) ?? false}
            />
          ))}
        </div>

        {/* Right pane — tick header over the SVG track, one shared width.
            Stays mounted when empty so the width observer survives (see the
            note above the return). */}
        <div ref={trackRef} className="relative min-w-0 flex-1">
          {isEmpty && (
            <ChartEmpty icon={GanttChartSquare} title={emptyMessage} />
          )}
          <div
            className={cn("relative border-b", isEmpty && "hidden")}
            style={{ height: HEADER_HEIGHT }}
          >
            {ticks.map((tick, i) => {
              const x = labelXFor(ticks, i, toX);
              if (x == null || x > width) return null;
              return (
                <span
                  key={tick.day}
                  className={cn(
                    "absolute top-1 whitespace-nowrap font-mono text-3xs uppercase tracking-wider",
                    tick.major ? "text-foreground" : "text-slate",
                  )}
                  style={{ left: x + 2 }}
                >
                  {tick.label}
                </span>
              );
            })}
          </div>

          <svg
            ref={svgRef}
            width={width}
            height={totalHeight}
            className={cn(isEmpty && "hidden")}
            aria-label="Gantt timeline"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={endPan}
            onMouseLeave={() => {
              endPan();
              setHoveredId(null);
              setPointer(null);
            }}
            style={{ cursor: isPanning ? "grabbing" : "grab" }}
          >
            <defs>
              {openEndedColors.map((color, i) => (
                <linearGradient
                  key={color}
                  id={`${gradientBase}-oe-${i}`}
                  x1="0"
                  x2="1"
                  y1="0"
                  y2="0"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={1} />
                  <stop offset="65%" stopColor={color} stopOpacity={1} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>

            {/* Group lane bands (behind everything). */}
            {rows.map((row, i) =>
              row.kind === "group" ? (
                <rect
                  key={row.id}
                  x={0}
                  y={i * ROW_HEIGHT}
                  width={width}
                  height={ROW_HEIGHT}
                  fill="var(--muted)"
                  opacity={0.6}
                />
              ) : null,
            )}

            {/* 1. Weekend bands. */}
            {weekends.map((band) => (
              <rect
                key={band.startDay}
                x={toX(band.startDay)}
                y={0}
                width={Math.max(1, toX(band.endDay + 1) - toX(band.startDay))}
                height={totalHeight}
                fill="var(--muted)"
                opacity={0.45}
              />
            ))}

            {/* 2. Gridlines. */}
            {ticks.map((tick) => {
              const x = toX(tick.day);
              if (x < 0 || x > width) return null;
              return (
                <line
                  key={tick.day}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={totalHeight}
                  stroke="var(--border)"
                  strokeWidth={tick.major ? 1.5 : 0.75}
                />
              );
            })}

            {/* 3. Envelopes — subtree reach beyond the row's own bar. */}
            {rows.map((row, i) => {
              if (row.kind !== "project" || row.envelope == null) return null;
              const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2;
              const x1 = toX(row.envelope.startDay);
              const x2 = toX(row.envelope.endDay + 1);
              return (
                <g
                  key={`env-${row.id}`}
                  opacity={isDimmed(row) ? 0.35 : 0.8}
                  stroke="var(--muted-foreground)"
                  strokeWidth={1}
                >
                  <line x1={x1} x2={x2} y1={cy} y2={cy} />
                  <line
                    x1={x1}
                    x2={x1}
                    y1={cy - CAP_HALF_HEIGHT}
                    y2={cy + CAP_HALF_HEIGHT}
                  />
                  <line
                    x1={x2}
                    x2={x2}
                    y1={cy - CAP_HALF_HEIGHT}
                    y2={cy + CAP_HALF_HEIGHT}
                  />
                </g>
              );
            })}

            {/* 4. Bars. */}
            {rows.map((row, i) => {
              const range = barRangeOf(row);
              if (range == null) return null;
              const barHeight =
                row.kind === "task" ? TASK_BAR_HEIGHT : PROJECT_BAR_HEIGHT;
              const y = i * ROW_HEIGHT + (ROW_HEIGHT - barHeight) / 2;
              const x1 = toX(range.startDay);
              const x2 = range.endDay == null ? width : toX(range.endDay + 1);
              if (x2 < 0 || x1 > width) return null;
              const barWidth = Math.max(MIN_BAR_WIDTH, x2 - x1);
              const color = getStatusChartColor(statusOf(row));
              const gradientId =
                range.endDay == null ? gradientIdFor(color) : null;
              const fill = gradientId == null ? color : `url(#${gradientId})`;
              const progress = progressOf(row);
              const onChain = chainIds?.has(row.id) ?? false;

              return (
                <g key={`bar-${row.id}`} opacity={isDimmed(row) ? 0.35 : 1}>
                  <rect
                    x={x1}
                    y={y}
                    width={barWidth}
                    height={barHeight}
                    fill={fill}
                    opacity={0.25}
                    rx={1}
                  />
                  {progress > 0 && (
                    <rect
                      x={x1}
                      y={y}
                      width={Math.max(MIN_BAR_WIDTH, barWidth * progress)}
                      height={barHeight}
                      fill={fill}
                      opacity={0.9}
                      rx={1}
                    />
                  )}
                  {onChain && (
                    <rect
                      x={x1}
                      y={y}
                      width={barWidth}
                      height={barHeight}
                      fill="none"
                      stroke="var(--foreground)"
                      strokeWidth={1.5}
                      rx={1}
                    />
                  )}
                  {range.endDay == null && (
                    <line
                      x1={x1 + barWidth}
                      x2={x1 + barWidth}
                      y1={y}
                      y2={y + barHeight}
                      stroke={color}
                      strokeWidth={1.5}
                      strokeDasharray="2 2"
                    />
                  )}
                </g>
              );
            })}

            {/* 5. Elbow connectors (surface B). */}
            {edges.map(([fromId, toId]) => {
              const fromIndex = rowIndexById.get(fromId);
              const toIndex = rowIndexById.get(toId);
              if (fromIndex == null || toIndex == null) return null;
              const fromRow = rows[fromIndex];
              const toRow = rows[toIndex];
              if (fromRow == null || toRow == null) return null;
              const fromRange = barRangeOf(fromRow);
              const toRange = barRangeOf(toRow);
              if (fromRange == null || toRange == null) return null;

              const y1 = fromIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
              const y2 = toIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
              const x1 =
                fromRange.endDay == null ? width : toX(fromRange.endDay + 1);
              const x2 = toX(toRange.startDay);
              const highlighted =
                hoveredId != null &&
                linkedIds.has(fromId) &&
                linkedIds.has(toId);
              const elbow = 6;
              const path =
                x2 >= x1 + elbow * 2
                  ? `M ${x1} ${y1} H ${x1 + elbow} V ${y2} H ${x2}`
                  : `M ${x1} ${y1} H ${x1 + elbow} V ${(y1 + y2) / 2} H ${x2 - elbow} V ${y2} H ${x2}`;

              return (
                <path
                  key={`${fromId}->${toId}`}
                  d={path}
                  fill="none"
                  stroke={
                    highlighted
                      ? "var(--foreground)"
                      : "var(--muted-foreground)"
                  }
                  strokeWidth={highlighted ? 1.5 : 1}
                  opacity={hoveredId != null && !highlighted ? 0.35 : 0.7}
                />
              );
            })}

            {/* 6. Today line. */}
            {todayDay >= viewWindow.startDay &&
              todayDay <= viewWindow.endDay && (
                <line
                  x1={toX(todayDay)}
                  x2={toX(todayDay)}
                  y1={0}
                  y2={totalHeight}
                  stroke="var(--primary)"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                />
              )}

            {/*
              Single pointer layer for the whole track. ALL bar-level pointer
              handling belongs here — hover today, and the deferred
              drag-to-reschedule tomorrow (a `pointerdown` here would
              `stopPropagation()` so it doesn't start a pan, then translate the
              px delta back into days via `fromX`). Keeping it in one layer is
              why row hit-testing is index arithmetic rather than per-bar
              handlers.
            */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG hit layer; hover drives the visualization, not a semantic control */}
            <g
              onMouseMove={(e) => {
                const svg = svgRef.current;
                if (svg == null) return;
                const rect = svg.getBoundingClientRect();
                const index = Math.floor((e.clientY - rect.top) / ROW_HEIGHT);
                const row = rows[index];
                setHoveredId(row == null ? null : row.id);
                // `fromX(e.clientX - rect.left)` is the day under the cursor —
                // the inverse-scale seam a future bar drag reads.
              }}
            >
              <rect
                x={0}
                y={0}
                width={width}
                height={totalHeight}
                fill="transparent"
              />
            </g>
          </svg>
        </div>
      </Row>

      {hoveredRow != null && pointer != null && (
        <ChartTooltip
          className="pointer-events-none absolute z-20 max-w-[16rem]"
          style={{
            left: pointer.x + 12,
            top: pointer.y + 12,
            transform:
              pointer.x > NAME_PANE_WIDTH + width - 200
                ? "translateX(-100%)"
                : undefined,
          }}
        >
          <TooltipBody row={hoveredRow} />
        </ChartTooltip>
      )}
    </div>
  );
}

/** Status of a row, or `null` for a group lane header. */
function statusOf(row: GanttRow): string | null {
  return match(row)
    .with({ kind: "group" }, () => null)
    .otherwise((r) => r.status);
}

// ---------------------------------------------------------------------------
// Left pane cell
// ---------------------------------------------------------------------------

function NameCell({
  row,
  renderName,
  onToggleExpand,
  onHover,
  dimmed,
  onChain,
}: {
  row: GanttRow;
  renderName?: (row: GanttRow) => ReactNode;
  onToggleExpand: (id: string) => void;
  onHover: (id: string | null) => void;
  dimmed: boolean;
  onChain: boolean;
}) {
  const depCount = dependencyCountOf(row);
  const indent =
    NAME_PANE_INSET +
    match(row)
      .with({ kind: "group" }, () => 0)
      .otherwise((r) => r.depth * INDENT_PER_DEPTH);

  if (row.kind === "group") {
    return (
      <Row
        align="center"
        justify="between"
        gap="sm"
        className="h-8 bg-muted/60 pr-2"
        style={{ paddingLeft: indent }}
      >
        <span className="truncate font-mono text-2xs text-slate uppercase tracking-wider">
          {row.label}
        </span>
        <span className="shrink-0 font-mono text-2xs text-slate">
          {row.count}
        </span>
      </Row>
    );
  }

  const expandable = row.kind === "project" && row.expandable;

  return (
    <Row
      align="center"
      gap="tight"
      className={cn(
        "h-8 border-b pr-2 transition-opacity",
        dimmed && "opacity-35",
      )}
      style={{ paddingLeft: indent }}
      onMouseEnter={() => onHover(row.id)}
    >
      {expandable ? (
        <button
          type="button"
          onClick={() => onToggleExpand(row.id)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={
            row.kind === "project" && row.expanded ? "Collapse" : "Expand"
          }
        >
          {row.kind === "project" && row.expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
      ) : (
        <span className="h-3 w-3 shrink-0" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          onChain && "font-semibold",
        )}
      >
        {renderName ? renderName(row) : row.name}
      </span>
      {depCount > 0 && (
        <Row
          as="span"
          align="center"
          gap="tight"
          className="shrink-0 rounded-sm bg-muted px-1 font-mono text-3xs text-slate"
        >
          <Link2 className="h-2 w-2" />
          {depCount}
        </Row>
      )}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function TooltipBody({ row }: { row: GanttRow }) {
  if (row.kind === "group") {
    return (
      <div>
        <div className="font-medium">{row.label}</div>
        <div className="text-muted-foreground text-xs">
          {row.count} {row.count === 1 ? "project" : "projects"}
        </div>
      </div>
    );
  }

  const range = barRangeOf(row);
  const dates =
    range == null
      ? "No dates"
      : range.endDay == null
        ? `${formatDate(fromDayIndex(range.startDay))} — ongoing`
        : range.startDay === range.endDay
          ? formatDate(fromDayIndex(range.startDay))
          : `${formatDate(fromDayIndex(range.startDay))} — ${formatDate(fromDayIndex(range.endDay))}`;

  return (
    <div>
      <div className="truncate font-medium">{row.name}</div>
      <div className="font-mono text-muted-foreground text-xs">{dates}</div>
      <div className="text-muted-foreground text-xs">{statusLabelOf(row)}</div>
      {row.kind === "project" && row.progress > 0 && (
        <div className="font-mono text-muted-foreground text-xs">
          {Math.round(row.progress * 100)}% complete
        </div>
      )}
    </div>
  );
}
