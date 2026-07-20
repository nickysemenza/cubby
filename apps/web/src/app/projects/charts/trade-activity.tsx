import {
  type TaskOut,
  type TaskStatus,
  type Trade,
  tradeValues,
} from "@cubby/schemas/project";
import { Hammer } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { getStatusChartColor } from "~/lib/status-colors";
import { formatDateRange, TRADE_LABELS } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";
import {
  buildTicks,
  fromDayIndex,
  toDayIndex,
  todayPlain,
} from "./gantt/gantt-date";

interface LaneTask {
  id: string;
  name: string;
  status: TaskStatus;
  startDay: number;
  endDay: number;
  projectName: string | null;
}

interface Lane {
  trade: Trade;
  label: string;
  tasks: LaneTask[];
}

const LANE_HEIGHT = 28;
const LANE_GAP = 6;
const MARGIN_LEFT = 160;
const MARGIN_RIGHT = 20;
const MARGIN_TOP = 24;
const MARGIN_BOTTOM = 4;
/** Widens the day domain past the outermost tasks so bars aren't clipped at the edges. */
const DAY_PADDING = 3;
const BAR_MIN_WIDTH = 8;
const MARK_RADIUS = 5;
const MARK_RADIUS_HOVER = 7;

/**
 * "When was I last doing plumbing?" — one horizontal lane per trade, with a
 * mark/bar per dated task. A task with `dueEndDate === null` is a 1-day task
 * (start === end, confirmed domain semantics — see
 * docs task-single-date-one-day), rendered as a diamond mark rather than a
 * degenerate zero-width bar; multi-day tasks render as a rounded bar.
 *
 * Only trades with at least one dated task get a lane, ordered by
 * `tradeValues`'s canonical construction-phase order (not insertion order)
 * so the lane list is stable across renders and matches the ordering used
 * elsewhere (tradeOptions, TRADE_LABELS).
 */
export function TradeActivity({ tasks }: { tasks: TaskOut[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width } = useContainerDimensions(containerRef, {
    minHeight: 80,
    initialWidth: 800,
  });
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);

  const { lanes, minDay, maxDay } = useMemo(() => {
    const byTrade = new Map<Trade, LaneTask[]>();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (const t of tasks) {
      if (t.dueDate == null) continue;
      const startDay = toDayIndex(t.dueDate);
      // A null dueEndDate means a 1-day task: start === end.
      const endDay = t.dueEndDate ? toDayIndex(t.dueEndDate) : startDay;
      min = Math.min(min, startDay);
      max = Math.max(max, endDay);

      const laneTask: LaneTask = {
        id: t.id,
        name: t.name,
        status: t.status,
        startDay,
        endDay,
        projectName: t.projectName,
      };
      const existing = byTrade.get(t.trade);
      if (existing) existing.push(laneTask);
      else byTrade.set(t.trade, [laneTask]);
    }

    if (byTrade.size === 0) {
      return { lanes: [] as Lane[], minDay: 0, maxDay: 0 };
    }

    const lanes: Lane[] = tradeValues
      .filter((trade) => byTrade.has(trade))
      .map((trade) => {
        const laneTasks = byTrade.get(trade);
        // `filter` above guarantees a Map hit; guard keeps noUncheckedIndexedAccess happy.
        if (laneTasks == null) throw new Error("unreachable");
        return {
          trade,
          label: TRADE_LABELS[trade],
          tasks: [...laneTasks].sort((a, b) => a.startDay - b.startDay),
        };
      });

    return { lanes, minDay: min - DAY_PADDING, maxDay: max + DAY_PADDING };
  }, [tasks]);

  if (lanes.length === 0) {
    return <ChartEmpty icon={Hammer} title="No dated tasks yet." />;
  }

  const chartWidth = Math.max(width - MARGIN_LEFT - MARGIN_RIGHT, 100);
  const chartHeight =
    MARGIN_TOP + lanes.length * (LANE_HEIGHT + LANE_GAP) + MARGIN_BOTTOM;
  const dayRange = Math.max(maxDay - minDay, 1);
  const toX = (day: number) =>
    MARGIN_LEFT + ((day - minDay) / dayRange) * chartWidth;

  const ticks = buildTicks(minDay, maxDay);
  const todayDay = toDayIndex(todayPlain());
  const showToday = todayDay >= minDay && todayDay <= maxDay;

  let hoveredTask: LaneTask | undefined;
  let hoveredLaneIndex = -1;
  if (hoveredTaskId != null) {
    for (const [i, lane] of lanes.entries()) {
      const found = lane.tasks.find((t) => t.id === hoveredTaskId);
      if (found) {
        hoveredTask = found;
        hoveredLaneIndex = i;
        break;
      }
    }
  }

  return (
    <div ref={containerRef} className="relative overflow-x-auto">
      <svg
        width={width}
        height={chartHeight}
        role="img"
        aria-label="Trade activity timeline"
      >
        <title>Trade activity timeline</title>

        {ticks.map((tick) => {
          const x = toX(tick.day);
          return (
            <g key={tick.day}>
              <line
                x1={x}
                y1={MARGIN_TOP - 4}
                x2={x}
                y2={chartHeight}
                stroke="var(--border)"
                strokeWidth={tick.major ? 1.5 : 1}
              />
              <text
                x={x}
                y={MARGIN_TOP - 10}
                textAnchor="middle"
                fontSize={11}
                fill="var(--muted-foreground)"
              >
                {tick.label}
              </text>
            </g>
          );
        })}

        {showToday && (
          <line
            x1={toX(todayDay)}
            y1={MARGIN_TOP - 4}
            x2={toX(todayDay)}
            y2={chartHeight}
            stroke="var(--chart-1)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )}

        {lanes.map((lane, i) => {
          const y = MARGIN_TOP + i * (LANE_HEIGHT + LANE_GAP);
          const centerY = y + LANE_HEIGHT / 2;
          return (
            <g key={lane.trade}>
              <text
                x={MARGIN_LEFT - 8}
                y={centerY}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={12}
                fill="var(--foreground)"
              >
                {lane.label}
              </text>
              <line
                x1={MARGIN_LEFT}
                y1={centerY}
                x2={width - MARGIN_RIGHT}
                y2={centerY}
                stroke="var(--border)"
                strokeWidth={1}
              />
              {lane.tasks.map((t) => {
                const isHovered = t.id === hoveredTaskId;
                const color = getStatusChartColor(t.status);

                if (t.startDay === t.endDay) {
                  const cx = toX(t.startDay);
                  const r = isHovered ? MARK_RADIUS_HOVER : MARK_RADIUS;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: hand-rolled SVG hover interaction, same pattern as location-treemap
                    <rect
                      key={t.id}
                      x={cx - r}
                      y={centerY - r}
                      width={r * 2}
                      height={r * 2}
                      fill={color}
                      transform={`rotate(45 ${cx} ${centerY})`}
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredTaskId(t.id)}
                      onMouseLeave={() => setHoveredTaskId(null)}
                    />
                  );
                }

                const x1 = toX(t.startDay);
                const x2 = toX(t.endDay);
                const barW = Math.max(x2 - x1, BAR_MIN_WIDTH);
                const halfH = isHovered ? 8 : 6;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: hand-rolled SVG hover interaction, same pattern as location-treemap
                  <rect
                    key={t.id}
                    x={x1}
                    y={centerY - halfH}
                    width={barW}
                    height={halfH * 2}
                    rx={3}
                    fill={color}
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredTaskId(t.id)}
                    onMouseLeave={() => setHoveredTaskId(null)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {hoveredTask && hoveredLaneIndex >= 0 && (
        <ChartTooltip
          className="pointer-events-none absolute z-50"
          style={{
            left: Math.min(
              Math.max(toX(hoveredTask.startDay) - 100, MARGIN_LEFT),
              Math.max(width - 220, 0),
            ),
            top: Math.max(
              MARGIN_TOP + hoveredLaneIndex * (LANE_HEIGHT + LANE_GAP) - 8,
              0,
            ),
          }}
        >
          <div className="font-medium">{hoveredTask.name}</div>
          <div className="text-muted-foreground">
            {formatDateRange(
              fromDayIndex(hoveredTask.startDay),
              hoveredTask.startDay === hoveredTask.endDay
                ? null
                : fromDayIndex(hoveredTask.endDay),
            )}
          </div>
          {hoveredTask.projectName && (
            <div className="text-2xs text-muted-foreground">
              {hoveredTask.projectName}
            </div>
          )}
        </ChartTooltip>
      )}
    </div>
  );
}
