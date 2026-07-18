import type { PurchaseOut } from "@cubby/schemas/project";
import { ResponsivePie } from "@nivo/pie";
import { sumBy } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import { capitalize, getCategoryColor } from "../shared";
import { ChartTooltip } from "./ChartTooltip";
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
  selectedCategory,
  onCategoryClick,
}: {
  purchases: PurchaseOut[];
  height?: number;
  centerLabel?: string;
  /** Category key to highlight (drill-down selection); center label shows its total. */
  selectedCategory?: string | null;
  /** When set, slices are clickable and report their category key. */
  onCategoryClick?: (categoryKey: string) => void;
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
        label: capitalize(category),
        value,
        color: getCategoryColor(category),
      }));

    const total = sumBy(data, (d) => d.value);
    return { data, total };
  }, [purchases]);

  if (data.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No purchase data." />;
  }

  const selected =
    selectedCategory != null
      ? data.find((d) => d.id === selectedCategory)
      : undefined;
  const centerValue = selected?.value ?? total;
  const centerText = selected ? selected.label : centerLabel;

  return (
    <div
      style={{ height }}
      className={onCategoryClick ? "[&_path]:cursor-pointer" : undefined}
    >
      <ResponsivePie
        data={data}
        colors={(d) => d.data.color}
        onClick={
          onCategoryClick ? (d) => onCategoryClick(String(d.id)) : undefined
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
