import type { CashFlowProjectionOut } from "@cubby/schemas/cash-flow";
import type { BarCustomLayerProps, BarDatum } from "@nivo/bar";
import { useMemo } from "react";

import { monthLabel } from "~/features/project/project-formatting";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/number-format";
import { ChartTooltip } from "~/ui/charts/chart-tooltip";
import { ResponsiveBar } from "~/ui/charts/nivo-responsive";

/** A clicked segment's source: a baseline bucket's Ledger rows or a project. */
export type CashFlowSegmentTarget =
  | { kind: "ledger"; filter: Record<string, string> }
  | { kind: "project"; id: string };

type Segment = {
  key: string;
  label: string;
  color: string;
  target: CashFlowSegmentTarget | null;
};

// Baseline buckets share one sequential family so the recurring floor reads
// as one layer; envelopes, committed and scenarios each get a distinct hue.
const BASELINE_COLORS = [
  "var(--chart-seq-5)",
  "var(--chart-seq-4)",
  "var(--chart-seq-3)",
  "var(--chart-seq-2)",
  "var(--chart-seq-1)",
];
const ENVELOPE_COLOR = "var(--chart-1)";
const COMMITTED_COLOR = "var(--chart-6)";
const SCENARIO_OUT_COLOR = "var(--chart-4)";
const SCENARIO_IN_COLOR = "var(--chart-positive)";
const NET_COLOR = "var(--foreground)";

export const cashFlowSegments = (data: CashFlowProjectionOut): Segment[] => [
  ...data.baseline.map((row, index) => ({
    key: `baseline:${row.key}`,
    label: row.label,
    color: BASELINE_COLORS[index % BASELINE_COLORS.length]!,
    target: row.ledgerFilter
      ? ({ kind: "ledger", filter: row.ledgerFilter } as const)
      : null,
  })),
  ...data.envelopes.map((envelope) => ({
    key: `envelope:${envelope.id}`,
    label: envelope.name,
    color: ENVELOPE_COLOR,
    target: { kind: "project", id: envelope.id } as const,
  })),
  {
    key: "committed",
    label: "Committed",
    color: COMMITTED_COLOR,
    target: null,
  },
  {
    key: "scenarioOutflow",
    label: "Scenario outflow",
    color: SCENARIO_OUT_COLOR,
    target: null,
  },
  {
    key: "scenarioInflow",
    label: "Scenario inflow",
    color: SCENARIO_IN_COLOR,
    target: null,
  },
];

type MonthDatum = BarDatum & { label: string; net: number };

/** The net series drawn over the bars at each month's band center. */
const netLineLayer = (rows: readonly MonthDatum[]) =>
  function NetLine({ bars, yScale }: BarCustomLayerProps<MonthDatum>) {
    // SAFETY: a vertical bar chart's value scale is linear, so it maps a
    // number to a pixel offset.
    const scaleY = yScale as (value: number) => number;
    const centers = new Map<string, number>();
    for (const bar of bars)
      centers.set(String(bar.data.indexValue), bar.x + bar.width / 2);
    const points = rows.flatMap((row) => {
      const x = centers.get(row.label);
      return x === undefined ? [] : [{ x, y: scaleY(row.net) }];
    });
    if (points.length === 0) return null;
    return (
      <g aria-hidden="true">
        <path
          d={points
            .map(
              (point, index) =>
                `${index === 0 ? "M" : "L"}${point.x},${point.y}`,
            )
            .join(" ")}
          fill="none"
          stroke={NET_COLOR}
          strokeWidth={1.5}
        />
        {points.map((point) => (
          <circle
            key={point.x}
            cx={point.x}
            cy={point.y}
            r={2.5}
            fill="var(--card)"
            stroke={NET_COLOR}
            strokeWidth={1.5}
          />
        ))}
      </g>
    );
  };

/**
 * Monthly stacked outflow above the axis (baseline buckets, envelopes,
 * committed, outflow scenarios), inflow scenarios below it, and the net line.
 * A specialized bar renderer: the chart kit has no signed stack with an
 * overlaid series.
 */
export function CashFlowChart({
  data,
  onOpen,
}: {
  data: CashFlowProjectionOut;
  onOpen: (target: CashFlowSegmentTarget) => void;
}) {
  const view = useMemo(() => {
    const segments = cashFlowSegments(data);
    const byKey = new Map(segments.map((segment) => [segment.key, segment]));
    const rows: MonthDatum[] = data.months.map((month) => {
      const row: MonthDatum = {
        label: monthLabel(month.month),
        net: month.net,
      };
      for (const entry of month.baseline)
        row[`baseline:${entry.key}`] = entry.amount;
      for (const entry of month.envelopes)
        row[`envelope:${entry.id}`] = entry.amount;
      row.committed = month.committed;
      row.scenarioOutflow = month.scenarioOutflow;
      row.scenarioInflow = -month.scenarioInflow;
      return row;
    });
    return { segments, byKey, rows, netLine: netLineLayer(rows) };
  }, [data]);

  const stride = Math.ceil(view.rows.length / 12);
  return (
    <div className="h-[340px]">
      <ResponsiveBar<MonthDatum>
        data={view.rows}
        keys={view.segments.map((segment) => segment.key)}
        indexBy="label"
        margin={{ top: 12, right: 16, bottom: 36, left: 64 }}
        padding={0.35}
        colors={({ id }) =>
          view.byKey.get(String(id))?.color ?? "var(--chart-neutral)"
        }
        {...nivoBarChrome}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          tickValues: view.rows
            .map((row) => row.label)
            .filter((_, index) => index % stride === 0),
        }}
        axisLeft={nivoCurrencyAxis}
        enableLabel={false}
        enableGridX={false}
        enableGridY
        markers={[
          {
            axis: "y",
            value: 0,
            lineStyle: { stroke: "var(--foreground)", strokeWidth: 1 },
          },
        ]}
        layers={["grid", "axes", "bars", "markers", view.netLine]}
        onClick={(datum) => {
          const target = view.byKey.get(String(datum.id))?.target;
          if (target) onOpen(target);
        }}
        tooltip={({ id, value, indexValue, data: row }) => {
          const segment = view.byKey.get(String(id));
          return (
            <ChartTooltip>
              <div className="mb-1 font-medium">{indexValue}</div>
              <div className="flex items-center gap-2">
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: segment?.color }}
                />
                <span>{segment?.label ?? id}</span>
                <strong className="ml-auto tabular-nums">
                  {formatCurrency(Math.abs(value ?? 0), 0)}
                </strong>
              </div>
              <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                Net {formatCurrency(row.net, 0)}
                {segment?.target ? " · Click to open" : ""}
              </div>
            </ChartTooltip>
          );
        }}
        theme={nivoChartTheme}
      />
    </div>
  );
}
