import { isPrincipalExpense } from "@cubby/schemas/expense-line-kind";
import type { ExpenseOut, Trade } from "@cubby/schemas/project";
import { ResponsiveLine } from "@nivo/line";
import { TrendUpIcon as TrendingUp } from "@phosphor-icons/react/dist/csr/TrendUp";
import { useMemo, useState } from "react";

import { Row, Stack } from "~/components/layout";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { nivoMotion } from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";

import {
  getCostTypeColor,
  nivoChartTheme,
  normalizeCostTypeKey,
  TRADE_LABELS,
} from "../shared";
import { ChartEmpty } from "./chart-empty";
import { ChartTooltip } from "./ChartTooltip";
import {
  buildCumulativeSpendPoints,
  buildStackedCumulativeSpend,
  type ExpenseSeries,
} from "./project-chart-data";

/**
 * One cumulative-spend chart with three lenses, replacing the old
 * SpendingOverTime + CostBurnup + CategoryTrend trio (which all plotted the
 * same cumulative curve, just un-split / split-by-cost-type):
 *
 * - **Total** — per-expense daily cumulative line with Cost Burnup's
 *   budget-crossing mechanics (negative-safe y-min, estimate marker that
 *   colors positive/warning/destructive, over-estimate point coloring).
 * - **By category** — monthly stacked cumulative areas per cost type.
 * - **By trade** — same monthly stacked shape grouped by trade, with the top
 *   6 trades on the warm categorical ramp and the rest folded into "Other".
 *
 * Negative expenses are real (refunds, the large negative family
 * contributions) — never filter to `cost > 0`, or the curve stops
 * reconciling with the project's actual spend.
 */
type SpendMode = "total" | "category" | "trade";

const MODE_OPTIONS: ViewSwitcherOption<SpendMode>[] = [
  { value: "total", label: "Total" },
  { value: "category", label: "By category" },
  { value: "trade", label: "By trade" },
];

// Warm categorical ramp for the top trades; everything past the top 6 folds
// into a single neutral "Other" series (14 trades would swamp a stacked area
// legend, and several share a Gantt phase color — ambiguous when stacked).
const TRADE_RAMP = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];
const OTHER_LABEL = "Other";
const OTHER_COLOR = "var(--chart-neutral)";

export function SpendingOverTime({
  expenses,
  costEstimate,
}: {
  expenses: ExpenseOut[];
  costEstimate: number | null;
}) {
  const [mode, setMode] = useState<SpendMode>("total");
  const principalExpenses = useMemo(
    () => expenses.filter(isPrincipalExpense),
    [expenses],
  );
  const adjustmentTotal = useMemo(
    () =>
      expenses.reduce(
        (total, expense) =>
          isPrincipalExpense(expense) ? total : total + (expense.cost ?? 0),
        0,
      ),
    [expenses],
  );

  const categorySeries = useMemo(
    () =>
      buildStackedCumulativeSpend(principalExpenses, (p) =>
        normalizeCostTypeKey(p.costType),
      ),
    [principalExpenses],
  );

  // Trade lens: rank trades by absolute total, keep the top 6 on the ramp,
  // fold the rest into one "Other" series. `colorById` maps the resulting
  // series labels (TRADE_LABELS / "Other") to their tokens.
  const { tradeSeries, tradeColorById } = useMemo(() => {
    const totals = new Map<Trade | null, number>();
    for (const p of principalExpenses) {
      if (!p.date || p.cost == null) continue;
      totals.set(p.trade, (totals.get(p.trade) ?? 0) + Math.abs(p.cost));
    }
    const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    const topTrades = new Set(
      ranked.slice(0, TRADE_RAMP.length).map(([t]) => t),
    );

    const colorById: Record<string, string> = {};
    ranked.slice(0, TRADE_RAMP.length).forEach(([trade], i) => {
      colorById[trade ? TRADE_LABELS[trade] : "Unassigned trade"] =
        TRADE_RAMP[i]!;
    });
    if (ranked.length > TRADE_RAMP.length) colorById[OTHER_LABEL] = OTHER_COLOR;

    const series = buildStackedCumulativeSpend(principalExpenses, (p) =>
      topTrades.has(p.trade)
        ? p.trade
          ? TRADE_LABELS[p.trade]
          : "Unassigned trade"
        : OTHER_LABEL,
    );
    return { tradeSeries: series, tradeColorById: colorById };
  }, [principalExpenses]);

  return (
    <Stack gap="sm">
      <Row justify="end">
        <ViewSwitcher
          options={MODE_OPTIONS}
          value={mode}
          onValueChange={setMode}
          ariaLabel="Spending chart mode"
        />
      </Row>
      {mode === "total" ? (
        <TotalSpend expenses={expenses} costEstimate={costEstimate} />
      ) : mode === "category" ? (
        <StackedSpend
          series={categorySeries}
          colorFor={(id) => getCostTypeColor(id)}
          costEstimate={costEstimate}
        />
      ) : (
        <StackedSpend
          series={tradeSeries}
          colorFor={(id) => tradeColorById[id] ?? OTHER_COLOR}
          costEstimate={costEstimate}
        />
      )}
      {mode !== "total" && adjustmentTotal !== 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          Total spend also includes {formatCurrency(adjustmentTotal, 0)} in
          purchase adjustments not assigned to this breakdown.
        </p>
      ) : null}
    </Stack>
  );
}

/**
 * Per-expense daily cumulative line against `costEstimate`. The reference
 * line and the points switch from positive/warning to destructive once
 * cumulative spend passes the estimate, so "did this blow the budget, and
 * when" reads at a glance. The cumulative curve isn't monotonic (negatives
 * are real), so the y-min clamps to the lowest point.
 */
function TotalSpend({
  expenses,
  costEstimate,
}: {
  expenses: ExpenseOut[];
  costEstimate: number | null;
}) {
  const points = useMemo(
    () => buildCumulativeSpendPoints(expenses),
    [expenses],
  );

  if (points.length === 0) {
    return <ChartEmpty icon={TrendingUp} title="No dated expense data." />;
  }

  const data = [{ id: "Cumulative Spend", data: points }];

  const ys = points.map((p) => p.y);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const finalSpend = points[points.length - 1]!.y;

  // Thin the x-axis to the date span — a fixed "every 2 weeks" turns ~100
  // overlapping rotated ticks when the data spans years (the whole-expenses
  // view). Show the year once the range crosses one.
  const firstX = String(points[0]!.x);
  const lastX = String(points[points.length - 1]!.x);
  const spanDays = (Date.parse(lastX) - Date.parse(firstX)) / 86_400_000;
  const { tickSpec, tickFmt } =
    spanDays > 730
      ? { tickSpec: "every 3 months", tickFmt: "%b '%y" }
      : spanDays > 365
        ? { tickSpec: "every 2 months", tickFmt: "%b '%y" }
        : spanDays > 120
          ? { tickSpec: "every month", tickFmt: "%b %d" }
          : { tickSpec: "every 2 weeks", tickFmt: "%b %d" };

  const yMax = Math.max(
    costEstimate ? Math.max(maxY * 1.1, costEstimate * 1.15) : maxY * 1.1,
    10,
  );
  const yMin = minY < 0 ? minY * 1.1 : 0;

  // Budget status drives the reference line + point coloring — destructive
  // once over, warning when close (>=90%), positive otherwise. No estimate
  // falls back to the neutral brand accent.
  let statusColor = "var(--chart-1)";
  let statusSuffix = "";
  if (costEstimate != null && costEstimate > 0) {
    const pct = finalSpend / costEstimate;
    if (pct > 1) {
      statusColor = "var(--destructive)";
      statusSuffix = " — over budget";
    } else if (pct >= 0.9) {
      statusColor = "var(--warning)";
      statusSuffix = " — nearly there";
    } else {
      statusColor = "var(--positive)";
    }
  }

  return (
    <div className="h-[300px]">
      <ResponsiveLine
        {...nivoMotion}
        data={data}
        margin={{ top: 20, right: 30, bottom: 50, left: 70 }}
        xScale={{ type: "time", format: "%Y-%m-%d", precision: "day" }}
        xFormat="time:%b %d"
        yScale={{ type: "linear", min: yMin, max: yMax }}
        axisBottom={{
          format: tickFmt,
          tickRotation: -45,
          tickValues: tickSpec,
        }}
        axisLeft={{
          format: (v: number) => formatCurrency(v, 0),
        }}
        enableArea
        areaOpacity={0.1}
        colors={["var(--chart-1)"]}
        pointSize={6}
        pointColor={({ point }) => {
          if (costEstimate == null) return "var(--card)";
          return Number(point.data.y) > costEstimate
            ? "var(--destructive)"
            : "var(--card)";
        }}
        pointBorderWidth={2}
        pointBorderColor={(point) => {
          if (costEstimate == null) return "var(--chart-1)";
          return Number(point.data.y) > costEstimate
            ? "var(--destructive)"
            : "var(--chart-1)";
        }}
        useMesh
        enableSlices="x"
        sliceTooltip={({ slice }) => (
          <ChartTooltip>
            {slice.points.map((point) => (
              <div key={point.id}>
                <span className="text-muted-foreground">
                  {point.data.xFormatted}
                </span>
                {": "}
                <strong>{formatCurrency(Number(point.data.y), 0)}</strong>
              </div>
            ))}
          </ChartTooltip>
        )}
        markers={
          costEstimate
            ? [
                {
                  axis: "y",
                  value: costEstimate,
                  lineStyle: {
                    stroke: statusColor,
                    strokeWidth: 2,
                    strokeDasharray: "8 4",
                  },
                  legend: `Estimate ${formatCurrency(costEstimate, 0)}${statusSuffix}`,
                  legendPosition: "top-right",
                  textStyle: {
                    fill: statusColor,
                    fontSize: 11,
                  },
                },
              ]
            : []
        }
        theme={nivoChartTheme}
      />
    </div>
  );
}

/**
 * Stacked cumulative monthly areas (category or trade lens). Needs 2+ months
 * for a meaningful trend; the estimate is a plain destructive dashed marker
 * (the per-series stack already carries the color signal).
 */
function StackedSpend({
  series,
  colorFor,
  costEstimate,
}: {
  series: ExpenseSeries[];
  colorFor: (id: string) => string;
  costEstimate: number | null;
}) {
  const monthCount = series[0]?.data.length ?? 0;
  if (series.length === 0 || monthCount < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough data for a trend (need 2+ months).
      </p>
    );
  }

  // Thin the month axis to ~12 labels max — a point scale draws every category
  // by default, so a multi-year range overlaps badly.
  const stride = Math.ceil(monthCount / 12);
  const monthTicks = series[0]!.data
    .map((d) => String(d.x))
    .filter((_, i) => i % stride === 0);

  return (
    <div className="h-[300px]">
      <ResponsiveLine
        data={series}
        margin={{ top: 20, right: 110, bottom: 50, left: 70 }}
        xScale={{ type: "point" }}
        yScale={{ type: "linear", min: 0, stacked: true }}
        axisBottom={{
          tickRotation: -45,
          tickValues: monthTicks,
        }}
        axisLeft={{
          format: (v: number) => formatCurrency(v, 0),
        }}
        enableArea
        areaOpacity={0.4}
        colors={(d) => colorFor(String(d.id))}
        pointSize={5}
        pointColor="var(--card)"
        pointBorderWidth={2}
        pointBorderColor={{ from: "serieColor" }}
        useMesh
        enableSlices="x"
        sliceTooltip={({ slice }) => (
          <ChartTooltip>
            <div className="mb-1 font-medium">
              {slice.points[0]?.data.xFormatted}
            </div>
            {slice.points.map((point) => (
              <div key={point.id} className="flex items-center gap-2">
                <div
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: point.seriesColor }}
                />
                <span>{point.seriesId}</span>
                <strong className="ml-auto">
                  {formatCurrency(Number(point.data.y), 0)}
                </strong>
              </div>
            ))}
          </ChartTooltip>
        )}
        markers={
          costEstimate
            ? [
                {
                  axis: "y",
                  value: costEstimate,
                  lineStyle: {
                    stroke: "var(--destructive)",
                    strokeWidth: 2,
                    strokeDasharray: "8 4",
                  },
                  legend: `Estimate ${formatCurrency(costEstimate, 0)}`,
                  legendPosition: "top-right",
                  textStyle: {
                    fill: "var(--destructive)",
                    fontSize: 11,
                  },
                },
              ]
            : []
        }
        legends={[
          {
            anchor: "bottom-right",
            direction: "column",
            translateX: 100,
            itemWidth: 90,
            itemHeight: 20,
            symbolSize: 10,
            symbolShape: "circle",
            itemTextColor: "var(--muted-foreground)",
          },
        ]}
        theme={nivoChartTheme}
      />
    </div>
  );
}
