import { ResponsivePie } from "@nivo/pie";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";
import { getCategoryColor } from "../shared";

export function AllCategoryDonut({
  purchases,
}: {
  purchases: NotionPurchase[];
}) {
  const { data, total } = useMemo(() => {
    const byCategory = new Map<string, number>();
    for (const p of purchases) {
      const cat = p.category ?? "uncategorized";
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + (p.cost ?? 0));
    }

    const data = Array.from(byCategory.entries())
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
    return <p className="text-muted-foreground text-sm">No purchase data.</p>;
  }

  return (
    <div className="h-[300px]">
      <ResponsivePie
        data={data}
        colors={(d) => d.data.color}
        margin={{ top: 30, right: 100, bottom: 30, left: 100 }}
        innerRadius={0.6}
        padAngle={1}
        cornerRadius={3}
        activeOuterRadiusOffset={6}
        arcLinkLabelsSkipAngle={10}
        arcLinkLabelsTextColor="#333"
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
              fill="#333"
            >
              <tspan x={centerX} dy="-0.5em" fontSize="18" fontWeight="bold">
                {formatCurrency(total, 0)}
              </tspan>
              <tspan x={centerX} dy="1.4em" fontSize="11" fill="#666">
                All projects
              </tspan>
            </text>
          ),
        ]}
      />
    </div>
  );
}
