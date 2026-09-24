import type { ProjectPortfolioAnalyticsOut } from "@cubby/schemas/project";
import { HammerIcon } from "@phosphor-icons/react/dist/csr/Hammer";
import { useMemo } from "react";

import { formatCurrency } from "~/lib/utils";

import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
  TRADE_LABELS,
} from "../shared";
import { ChartEmpty } from "./chart-empty";
import { ChartTooltip } from "./ChartTooltip";
import { HorizontalBarChart } from "./horizontal-bar-chart";

type Datum = {
  trade: string;
  actual: number;
  committed: number;
};

/**
 * `data` is `portfolioAnalytics`'s `tradeActivity` — actual + committed
 * spend per trade, across every project matching the dashboard's filter
 * scope (see repo/project/portfolio-analytics.ts). This replaces the old
 * per-task Gantt-lane timeline ("when was each trade last active", built off
 * raw dated tasks) — the server aggregate has no task-level dates, only
 * dollar totals per trade, so the chart now answers "where is the money
 * going by trade" instead of "when did each trade last have activity".
 */
export function TradeActivity({
  data: rows,
  adjustments,
}: {
  data: ProjectPortfolioAnalyticsOut["tradeActivity"];
  adjustments: number;
}) {
  const data = useMemo(
    () =>
      rows
        .map((r): Datum => ({
          trade: r.trade ? TRADE_LABELS[r.trade] : "Unassigned trade",
          actual: r.actual,
          committed: r.committed,
        }))
        .filter((d) => d.actual > 0 || d.committed > 0)
        .sort((a, b) => a.actual + a.committed - (b.actual + b.committed)),
    [rows],
  );

  if (data.length === 0) {
    return (
      <div>
        <ChartEmpty icon={HammerIcon} title="No principal trade spend yet." />
        {adjustments !== 0 ? (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Total spend is {formatCurrency(adjustments, 0)} in purchase
            adjustments, with no principal trade bars.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <HorizontalBarChart
        data={data}
        rowHeight={40}
        minHeight={220}
        keys={["actual", "committed"]}
        indexBy="trade"
        groupMode="stacked"
        margin={{ top: 10, right: 30, bottom: 40, left: 140 }}
        padding={0.3}
        colors={({ id }) =>
          id === "actual" ? "var(--chart-1)" : "var(--chart-7)"
        }
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
        }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={40}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        legendLabel={(d) => (d.id === "actual" ? "Actual" : "Committed")}
        legends={[
          {
            dataFrom: "keys",
            anchor: "bottom",
            direction: "row",
            translateY: 40,
            itemWidth: 90,
            itemHeight: 20,
            symbolSize: 12,
            symbolShape: "circle",
            itemTextColor: "var(--muted-foreground)",
          },
        ]}
        tooltip={({ id, value, indexValue, color }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong> —{" "}
            {id === "actual" ? "Actual" : "Committed"}:{" "}
            <span style={{ color }}>{formatCurrency(value, 0)}</span>
          </ChartTooltip>
        )}
        theme={nivoChartTheme}
      />
      {adjustments !== 0 ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Total spend also includes {formatCurrency(adjustments, 0)} in purchase
          adjustments not assigned to a trade.
        </p>
      ) : null}
    </div>
  );
}
