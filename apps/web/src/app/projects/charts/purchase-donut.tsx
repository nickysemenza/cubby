import type { PurchaseOut } from "@cubby/schemas/project";
import { ResponsivePie } from "@nivo/pie";
import { sumBy } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import { capitalize, getCostTypeColor } from "../shared";
import { ChartTooltip, TooltipPurchaseBreakdown } from "./ChartTooltip";
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
  selectedCostType,
  onCostTypeClick,
}: {
  purchases: PurchaseOut[];
  height?: number;
  centerLabel?: string;
  /** Cost-type key to highlight (drill-down selection); center label shows its total. */
  selectedCostType?: string | null;
  /** When set, slices are clickable and report their cost-type key. */
  onCostTypeClick?: (costTypeKey: string) => void;
}) {
  const { data, total, purchasesByType } = useMemo(() => {
    const byCostType = sumByKey(
      purchases,
      (p) => p.costType ?? "other",
      (p) => p.cost,
    );

    const data: DonutDatum[] = Array.from(byCostType.entries())
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([costType, value]) => ({
        id: costType,
        label: capitalize(costType),
        value,
        color: getCostTypeColor(costType),
      }));

    // Purchases behind each slice, for the tooltip's top-3 breakdown.
    const purchasesByType = new Map<string, PurchaseOut[]>();
    for (const p of purchases) {
      const key = p.costType ?? "other";
      const list = purchasesByType.get(key);
      if (list) list.push(p);
      else purchasesByType.set(key, [p]);
    }

    const total = sumBy(data, (d) => d.value);
    return { data, total, purchasesByType };
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No purchase data." />;
  }

  const selected =
    selectedCostType != null
      ? data.find((d) => d.id === selectedCostType)
      : undefined;
  const centerValue = selected?.value ?? total;
  const centerText = selected ? selected.label : centerLabel;

  return (
    <div
      style={{ height }}
      className={onCostTypeClick ? "[&_path]:cursor-pointer" : undefined}
    >
      <ResponsivePie
        data={data}
        colors={(d) => d.data.color}
        onClick={
          onCostTypeClick ? (d) => onCostTypeClick(String(d.id)) : undefined
        }
        // Controlled while a slice is drilled in — the selected arc stays
        // popped out (activeOuterRadiusOffset). Uncontrolled hover otherwise.
        // (Don't fade unselected slices via color: Nivo's color interpolator
        // can't parse color-mix() and silently keeps the full color.)
        activeId={selected ? selected.id : undefined}
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
            <TooltipPurchaseBreakdown
              purchases={purchasesByType.get(String(datum.id)) ?? []}
            />
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
