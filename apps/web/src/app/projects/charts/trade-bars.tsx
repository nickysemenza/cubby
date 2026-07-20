import type { PurchaseOut, Trade } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import {
  getCostTypeColor,
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
  TRADE_LABELS,
} from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";
import { buildTradeCostPivot, PIVOT_COST_KEYS } from "./trade-cost-pivot";

type BarDatum = {
  trade: string;
  materials: number;
  tools: number;
  services: number;
  other: number;
  total: number;
};

const tradeLabel = (value: string): string =>
  TRADE_LABELS[value as Trade] ?? value;

export function TradeBars({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo<BarDatum[]>(() => {
    const { rows } = buildTradeCostPivot(purchases);
    // Stacked bars can't render negative-net rows — drop them here (the
    // matrix keeps them). The helper sorts total DESC, but nivo horizontal
    // bars render bottom-up — reverse to keep the biggest-on-top visual.
    return rows
      .filter((row) => row.total > 0)
      .map((row) => ({ trade: row.trade, ...row.cells, total: row.total }))
      .reverse();
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No purchase data." />;
  }

  const chartHeight = Math.max(300, data.length * 32 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={[...PIVOT_COST_KEYS]}
        indexBy="trade"
        layout="horizontal"
        margin={{ top: 10, right: 60, bottom: 40, left: 200 }}
        padding={0.25}
        colors={(bar) => getCostTypeColor(bar.id as string)}
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          format: tradeLabel,
        }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={40}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        tooltip={({ id, value, indexValue, color }) => (
          <ChartTooltip>
            <strong>{tradeLabel(String(indexValue))}</strong> — {id}:{" "}
            <span style={{ color }}>{formatCurrency(value, 0)}</span>
          </ChartTooltip>
        )}
        legends={[
          {
            dataFrom: "keys",
            anchor: "bottom",
            direction: "row",
            translateY: 40,
            itemWidth: 100,
            itemHeight: 20,
            symbolSize: 12,
            symbolShape: "circle",
            itemTextColor: "var(--muted-foreground)",
          },
        ]}
        theme={nivoChartTheme}
      />
    </div>
  );
}
