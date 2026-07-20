import type { PurchaseOut, Trade } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { sum } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import {
  getCostTypeColor,
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
  normalizeCostTypeKey,
  TRADE_LABELS,
} from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type BarDatum = {
  trade: string;
  materials: number;
  tools: number;
  services: number;
  other: number;
  total: number;
};

const COST_TYPE_KEYS = ["materials", "tools", "services", "other"] as const;

const tradeLabel = (value: string): string =>
  TRADE_LABELS[value as Trade] ?? value;

export function TradeBars({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo(() => {
    // Group by trade, then by cost type within each
    const grouped = new Map<string, Record<string, number>>();

    for (const p of purchases) {
      const trade = p.trade ?? "other";
      const costType = normalizeCostTypeKey(p.costType);
      const cost = p.cost ?? 0;

      if (!grouped.has(trade)) {
        grouped.set(trade, {
          materials: 0,
          tools: 0,
          services: 0,
          other: 0,
        });
      }
      const entry = grouped.get(trade)!;
      entry[costType] = (entry[costType] ?? 0) + cost;
    }

    return Array.from(grouped.entries())
      .map(([trade, costTypes]) => ({
        trade,
        ...costTypes,
        total: sum(Object.values(costTypes)),
      }))
      .filter((d) => d.total > 0)
      .sort((a, b) => a.total - b.total) as BarDatum[];
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No purchase data." />;
  }

  const chartHeight = Math.max(300, data.length * 32 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={[...COST_TYPE_KEYS]}
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
