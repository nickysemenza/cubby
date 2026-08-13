import type { ExpenseCostTypeAggregate } from "@cubby/schemas/project";
import { ResponsivePie } from "@nivo/pie";
import { sumBy } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { capitalize } from "~/app/projects/project-formatting";
import { nivoMotion } from "~/lib/nivo-theme";
import { getCostTypeColor } from "~/lib/status-colors";
import { formatCurrency } from "~/lib/utils";

type DonutDatum = {
  id: string;
  label: string;
  value: number;
  color: string;
  count: number;
};

/**
 * Cost-type breakdown donut sourced from `expense.analytics`'s `byCostType`
 * aggregate (one grouped SQL sum per cost type) — the analytics-view
 * replacement for `ExpenseDonut`, which summed a raw expense fetch
 * client-side. Same positive-arcs / net-center convention: the ring only
 * draws cost types with positive net (arcs can't render a negative slice),
 * the center label carries the true net across every bucket including
 * negative ones (refunds/credits).
 */
export function CostTypeDonut({
  byCostType,
  height = 300,
  selected,
  onSelect,
}: {
  byCostType: ExpenseCostTypeAggregate[];
  height?: number;
  selected?: string | null;
  onSelect?: (costType: string) => void;
}) {
  const { data, total, netTotal } = useMemo(() => {
    const data: DonutDatum[] = byCostType
      .filter((row) => row.net > 0)
      .sort((a, b) => b.net - a.net)
      .map((row) => ({
        id: row.costType,
        label: capitalize(row.costType),
        value: row.net,
        color: getCostTypeColor(row.costType),
        count: row.count,
      }));
    const total = sumBy(data, (d) => d.value);
    const netTotal = sumBy(byCostType, (row) => row.net);
    return { data, total, netTotal };
  }, [byCostType]);

  if (data.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No expense data." />;
  }

  const selectedDatum = selected
    ? data.find((d) => d.id === selected)
    : undefined;
  const centerValue = selectedDatum?.value ?? netTotal;
  const centerText = selectedDatum ? selectedDatum.label : "Net total";

  return (
    <div
      style={{ height }}
      className={onSelect ? "[&_path]:cursor-pointer" : undefined}
    >
      <ResponsivePie
        {...nivoMotion}
        data={data}
        colors={(d) => d.data.color}
        onClick={onSelect ? (d) => onSelect(String(d.id)) : undefined}
        activeId={selectedDatum ? selectedDatum.id : undefined}
        margin={{ top: 30, right: 100, bottom: 30, left: 100 }}
        innerRadius={0.6}
        padAngle={1}
        cornerRadius={0}
        activeOuterRadiusOffset={6}
        arcLinkLabelsSkipAngle={10}
        arcLinkLabelsTextColor="var(--foreground)"
        arcLinkLabelsColor={{ from: "color" }}
        arcLinkLabel={(d) => `${d.label} ${formatCurrency(d.value, 0)}`}
        arcLabelsSkipAngle={20}
        arcLabel={(d) => `${Math.round((d.value / total) * 100)}%`}
        arcLabelsTextColor="var(--background)"
        enableArcLabels
        tooltip={({ datum }) => (
          <ChartTooltip>
            <span style={{ color: datum.color }}>{datum.label}</span>:{" "}
            <strong>{formatCurrency(datum.value, 0)}</strong> (
            {((datum.value / total) * 100).toFixed(1)}%)
            <div className="mt-1 text-muted-foreground text-xs">
              {datum.data.count} expense{datum.data.count === 1 ? "" : "s"}
            </div>
          </ChartTooltip>
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
              style={{ fill: "var(--foreground)" }}
            >
              <tspan x={centerX} dy="-0.5em" className="font-bold text-xl">
                {formatCurrency(centerValue, 0)}
              </tspan>
              <tspan
                x={centerX}
                dy="1.4em"
                className="text-xs"
                style={{ fill: "var(--muted-foreground)" }}
              >
                {centerText}
              </tspan>
            </text>
          ),
        ]}
      />
    </div>
  );
}
