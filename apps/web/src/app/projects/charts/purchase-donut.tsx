import { ResponsivePie } from "@nivo/pie";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import type { NotionPurchase } from "~/server/clients/notion";
import { getCategoryColor } from "../shared";
import { ChartEmpty } from "./chart-empty";

type DonutDatum = {
  id: string;
  label: string;
  value: number;
  color: string;
};

export function PurchaseDonut({
  purchases,
  height = 350,
  centerLabel = "Total cost",
}: {
  purchases: NotionPurchase[];
  height?: number;
  centerLabel?: string;
}) {
  const { data, total } = useMemo(() => {
    const byCategory = sumByKey(
      purchases,
      (p) => p.category ?? "other",
      (p) => p.cost,
    );

    const data: DonutDatum[] = Array.from(byCategory.entries())
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([category, value]) => ({
        id: category,
        label: category,
        value,
        color: getCategoryColor(category),
      }));

    const total = data.reduce((sum, d) => sum + d.value, 0);
    return { data, total };
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No purchase data." />;
  }

  return (
    <div style={{ height }}>
      <ResponsivePie
        data={data}
        colors={(d) => d.data.color}
        margin={{ top: 30, right: 100, bottom: 30, left: 100 }}
        innerRadius={0.6}
        padAngle={1}
        cornerRadius={3}
        activeOuterRadiusOffset={6}
        arcLinkLabelsSkipAngle={10}
        arcLinkLabelsTextColor="hsl(var(--foreground))"
        arcLinkLabelsColor={{ from: "color" }}
        arcLinkLabel={(d) => `${d.label} ${formatCurrency(d.value, 0)}`}
        arcLabelsSkipAngle={20}
        arcLabel={(d) => `${Math.round((d.value / total) * 100)}%`}
        arcLabelsTextColor="white"
        enableArcLabels
        tooltip={({ datum }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
            <span style={{ color: datum.color }}>{datum.label}</span>:{" "}
            <strong>{formatCurrency(datum.value, 0)}</strong> (
            {((datum.value / total) * 100).toFixed(1)}%)
          </div>
        )}
        layers={[
          "arcs",
          "arcLabels",
          "arcLinkLabels",
          "legends",
          ({ centerX, centerY }) => (
            <text
              x={centerX}
              y={centerY}
              textAnchor="middle"
              dominantBaseline="central"
              style={{ fill: "hsl(var(--foreground))" }}
            >
              <tspan x={centerX} dy="-0.5em" className="font-bold text-xl">
                {formatCurrency(total, 0)}
              </tspan>
              <tspan
                x={centerX}
                dy="1.4em"
                className="text-xs"
                style={{ fill: "hsl(var(--muted-foreground))" }}
              >
                {centerLabel}
              </tspan>
            </text>
          ),
        ]}
      />
    </div>
  );
}
