import type { PurchaseOut } from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { sum } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import {
  CATEGORY_COLORS,
  nivoBarChrome,
  nivoChartTheme,
  normalizeCategoryKey,
} from "../shared";
import { ChartTooltip } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type BarDatum = {
  subcategory: string;
  materials: number;
  tools: number;
  services: number;
  other: number;
  total: number;
};

const CATEGORY_KEYS = ["materials", "tools", "services", "other"] as const;

export function SubcategoryBars({ purchases }: { purchases: PurchaseOut[] }) {
  const data = useMemo(() => {
    // Group by subcategory, then by category within each
    const grouped = new Map<string, Record<string, number>>();

    for (const p of purchases) {
      const sub = p.subcategory ?? "other";
      const cat = normalizeCategoryKey(p.category);
      const cost = p.cost ?? 0;

      if (!grouped.has(sub)) {
        grouped.set(sub, {
          materials: 0,
          tools: 0,
          services: 0,
          other: 0,
        });
      }
      const entry = grouped.get(sub)!;
      entry[cat] = (entry[cat] ?? 0) + cost;
    }

    return Array.from(grouped.entries())
      .map(([subcategory, cats]) => ({
        subcategory,
        ...cats,
        total: sum(Object.values(cats)),
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
        keys={[...CATEGORY_KEYS]}
        indexBy="subcategory"
        layout="horizontal"
        margin={{ top: 10, right: 60, bottom: 40, left: 200 }}
        padding={0.25}
        colors={(bar) => {
          const key = bar.id as string;
          return CATEGORY_COLORS[key] ?? "var(--chart-neutral)";
        }}
        {...nivoBarChrome}
        axisBottom={{
          format: (v: number) => formatCurrency(v, 0),
        }}
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
        tooltip={({ id, value, indexValue, color }) => (
          <ChartTooltip>
            <strong>{indexValue}</strong> — {id}:{" "}
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
