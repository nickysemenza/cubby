import type { AiUsageSummaryRow } from "@cubby/schemas/ai";
import { AI_USAGE_TRANSPORT_LABELS as transportLabels } from "@cubby/schemas/telemetry";
import { recordKeys } from "@cubby/shared";
import { ChartBarIcon } from "@phosphor-icons/react/dist/csr/ChartBar";
import { useMemo } from "react";

import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import { nivoBarChrome, nivoChartTheme } from "~/lib/nivo-theme";
import { cn } from "~/lib/utils";
import { ChartTooltip } from "~/ui/charts/chart-tooltip";
import { ResponsiveBar } from "~/ui/charts/nivo-responsive";
import { formatAiCost } from "~/ui/common/ai-cost";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Visualization } from "~/ui/visualizations/visualization";

export const usageChartDimensions = {
  feature: "Feature",
  model: "Model",
  provider: "Provider",
  transport: "Transport",
} as const;
export type UsageChartDimension = keyof typeof usageChartDimensions;
export type UsageChartMeasure = "charged" | "standard";
export interface UsageChartSelection {
  dimension: UsageChartDimension;
  value: string;
}

const OTHER = "Other";
const CHART_HEIGHT = 280;
const LEGEND_HEIGHT = 20;
// Matches the column's `gap-3` between the plot and its legend.
const LEGEND_GAP = 12;
const MAX_SERIES = 7;
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
];

// Standard cost is what was charged plus what each billing reason avoided;
// the stack shows where the difference went.
const STANDARD_PARTS = [
  { key: "Charged", color: "var(--chart-1)" },
  { key: "Plan covered", color: "var(--chart-2)" },
  { key: "Subscriber credits", color: "var(--chart-3)" },
  { key: "Cache", color: "var(--chart-4)" },
  { key: "Discount", color: "var(--chart-5)" },
] as const;

type DayDatum = { day: string } & Record<string, number | string>;

function seriesLabel(dimension: UsageChartDimension, value: string) {
  if (dimension !== "transport") return value;
  return (
    Object.entries(transportLabels).find(([key]) => key === value)?.[1] ?? value
  );
}

/** Every household day in the window, so idle days stay visible. */
function dayRange(rows: readonly AiUsageSummaryRow[], days: number): string[] {
  const last = householdLocalDate();
  const windowStart = shiftPlainDate(last, 1 - days);
  // The server window is a rolling instant, so its first row can fall on the
  // household day before the window's first full day.
  const first = rows.reduce(
    (earliest, row) => (row.day < earliest ? row.day : earliest),
    windowStart,
  );
  const range: string[] = [];
  for (let day = first; day <= last; day = shiftPlainDate(day, 1))
    range.push(day);
  return range;
}

function chartData(
  rows: readonly AiUsageSummaryRow[],
  windowDays: number,
  dimension: UsageChartDimension,
  measure: UsageChartMeasure,
) {
  const days = dayRange(rows, windowDays);
  const byDay = new Map(days.map((day): [string, DayDatum] => [day, { day }]));
  const add = (day: string, key: string, amount: number) => {
    const datum = byDay.get(day);
    if (datum && amount !== 0) datum[key] = Number(datum[key] ?? 0) + amount;
  };

  if (measure === "standard") {
    for (const row of rows) {
      const { plan, subscriberCredit, cache, discount } = row.savingsByReason;
      add(row.day, "Charged", row.chargedCost);
      add(row.day, "Plan covered", plan);
      add(row.day, "Subscriber credits", subscriberCredit);
      add(row.day, "Cache", cache);
      add(row.day, "Discount", discount);
    }
    const keys = STANDARD_PARTS.map((part) => part.key).filter((key) =>
      [...byDay.values()].some((datum) => datum[key] !== undefined),
    );
    return {
      data: [...byDay.values()],
      keys,
      colors: Object.fromEntries(
        STANDARD_PARTS.map((part) => [part.key, part.color]),
      ),
    };
  }

  const totals = new Map<string, number>();
  for (const row of rows)
    totals.set(
      row[dimension],
      (totals.get(row[dimension]) ?? 0) + row.chargedCost,
    );
  const ranked = [...totals]
    .filter(([, total]) => total > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([value]) => value);
  const shown = new Set(
    ranked.length > MAX_SERIES + 1 ? ranked.slice(0, MAX_SERIES) : ranked,
  );
  for (const row of rows)
    add(
      row.day,
      shown.has(row[dimension]) ? row[dimension] : OTHER,
      row.chargedCost,
    );
  const keys = [...shown, ...(shown.size < ranked.length ? [OTHER] : [])];
  return {
    data: [...byDay.values()],
    keys,
    colors: Object.fromEntries(
      keys.map((key, index) => [
        key,
        key === OTHER ? "var(--chart-neutral)" : SERIES_COLORS[index]!,
      ]),
    ),
  };
}

/**
 * Daily AI cost, stacked by one usage dimension (charged cost) or by where
 * the standard comparison went (charged plus each savings reason). Choosing
 * a series filters the summary table; "Other" folds the long tail.
 */
export function AiUsageChart({
  rows,
  days,
  loading,
  dimension,
  onDimensionChange,
  measure,
  onMeasureChange,
  selection,
  onSelect,
}: {
  rows: readonly AiUsageSummaryRow[];
  /** The summary window; idle days in it still get a slot. */
  days: number;
  loading: boolean;
  dimension: UsageChartDimension;
  onDimensionChange: (dimension: UsageChartDimension) => void;
  measure: UsageChartMeasure;
  onMeasureChange: (measure: UsageChartMeasure) => void;
  selection: UsageChartSelection | null;
  onSelect: (selection: UsageChartSelection | null) => void;
}) {
  const { data, keys, colors } = useMemo(
    () => chartData(rows, days, dimension, measure),
    [rows, days, dimension, measure],
  );
  const selectable = measure === "charged";
  const select = (key: string) => {
    if (!selectable || key === OTHER) return;
    onSelect(
      selection?.dimension === dimension && selection.value === key
        ? null
        : { dimension, value: key },
    );
  };
  const label = (key: string) =>
    selectable ? seriesLabel(dimension, key) : key;
  const dimmed = (key: string) =>
    selectable && selection?.dimension === dimension && selection.value !== key;
  // Daily ticks collide past two weeks; keep about ten.
  const stride = Math.ceil(data.length / 10);
  const tickValues = data
    .map((datum) => datum.day)
    .filter((_, index) => index % stride === 0);

  return (
    <div className="flex flex-col gap-3">
      <Row justify="between" align="center" gap="sm" wrap>
        <Row gap="xs" align="center" wrap>
          {(["charged", "standard"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={measure === value ? "secondary" : "outline"}
              aria-pressed={measure === value}
              onClick={() => onMeasureChange(value)}
            >
              {value === "charged" ? "Charged" : "Standard"}
            </Button>
          ))}
        </Row>
        {selectable ? (
          <Row gap="xs" align="center" wrap>
            <span className="text-sm text-muted-foreground">Group by</span>
            {recordKeys(usageChartDimensions).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={dimension === value ? "secondary" : "outline"}
                aria-pressed={dimension === value}
                onClick={() => onDimensionChange(value)}
              >
                {usageChartDimensions[value]}
              </Button>
            ))}
          </Row>
        ) : null}
      </Row>
      {/* Every state keeps the plotted height and a legend line, so the
          tables below never move when the summary or the chart chunk lands. */}
      {loading || keys.length === 0 ? (
        <Visualization
          state={loading ? { status: "loading" } : { status: "empty" }}
          height={CHART_HEIGHT + LEGEND_GAP + LEGEND_HEIGHT}
          icon={ChartBarIcon}
          message={
            measure === "charged"
              ? "No charged cost in this window."
              : "No priced comparison in this window."
          }
        />
      ) : (
        <>
          <div style={{ height: CHART_HEIGHT }}>
            <ResponsiveBar
              data={data}
              keys={keys}
              indexBy="day"
              groupMode="stacked"
              colors={({ id }) => {
                const color = colors[String(id)] ?? "var(--chart-neutral)";
                return dimmed(String(id))
                  ? `color-mix(in oklch, ${color} 25%, var(--background))`
                  : color;
              }}
              margin={{ top: 10, right: 16, bottom: 50, left: 64 }}
              padding={0.25}
              {...nivoBarChrome}
              theme={nivoChartTheme}
              enableLabel={false}
              enableGridY
              enableGridX={false}
              axisBottom={{
                tickSize: 0,
                tickPadding: 8,
                tickRotation: -45,
                tickValues,
              }}
              axisLeft={{
                tickValues: 5,
                format: (value) => formatAiCost(value),
              }}
              onClick={(bar) => select(String(bar.id))}
              tooltip={({ id, value, indexValue, data: datum }) => (
                <ChartTooltip>
                  <div className="font-semibold">{indexValue}</div>
                  <div>
                    {label(String(id))} — {formatAiCost(value)}
                  </div>
                  <div className="text-muted-foreground">
                    Day total{" "}
                    {formatAiCost(
                      keys.reduce(
                        (sum, key) => sum + Number(datum[key] ?? 0),
                        0,
                      ),
                    )}
                  </div>
                </ChartTooltip>
              )}
              ariaLabel={`Daily ${measure} AI cost${
                selectable
                  ? ` by ${usageChartDimensions[dimension].toLowerCase()}`
                  : ""
              }`}
            />
          </div>
          <ul
            className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
            style={{ minHeight: LEGEND_HEIGHT }}
          >
            {keys.map((key) => {
              const swatch = (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ background: colors[key] }}
                />
              );
              return (
                <li key={key}>
                  {selectable && key !== OTHER ? (
                    <button
                      type="button"
                      aria-pressed={
                        selection?.dimension === dimension &&
                        selection.value === key
                      }
                      onClick={() => select(key)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        dimmed(key) && "text-muted-foreground",
                      )}
                    >
                      {swatch}
                      {label(key)}
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {swatch}
                      {label(key)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
