import { ResponsiveBar } from "@nivo/bar";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import type { NotionPurchase } from "~/server/clients/notion";

export function SpendingByProject({
  purchases,
}: {
  purchases: NotionPurchase[];
}) {
  const data = useMemo(() => {
    const byProject = new Map<string, number>();
    for (const p of purchases) {
      const name = p.projectName ?? "Unassigned";
      byProject.set(name, (byProject.get(name) ?? 0) + (p.cost ?? 0));
    }

    return Array.from(byProject.entries())
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reverse()
      .map(([project, cost]) => ({ project, cost }));
  }, [purchases]);

  if (data.length === 0) {
    return <p className="text-muted-foreground text-sm">No spending data.</p>;
  }

  const chartHeight = Math.max(250, data.length * 32 + 60);

  return (
    <div style={{ height: chartHeight }}>
      <ResponsiveBar
        data={data}
        keys={["cost"]}
        indexBy="project"
        layout="horizontal"
        margin={{ top: 10, right: 80, bottom: 30, left: 160 }}
        padding={0.3}
        colors={["hsl(210, 60%, 55%)"]}
        borderRadius={2}
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
        labelSkipWidth={50}
        labelTextColor="white"
        enableGridX
        enableGridY={false}
        tooltip={({ indexValue, value }) => (
          <div className="rounded-md bg-popover px-3 py-2 text-sm shadow-md ring-1 ring-border">
            <strong>{indexValue}</strong>: {formatCurrency(value, 0)}
          </div>
        )}
        theme={{
          text: { fill: "#333" },
          axis: { ticks: { text: { fill: "#666" } } },
          grid: { line: { stroke: "#e5e5e5", strokeWidth: 1 } },
        }}
      />
    </div>
  );
}
