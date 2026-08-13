import { isPrincipalExpense } from "@cubby/schemas/expense-line-kind";
import type { ExpenseOut } from "@cubby/schemas/project";
import { ResponsivePie } from "@nivo/pie";
import { sumBy } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { Stack } from "~/components/layout";
import { nivoMotion } from "~/lib/nivo-theme";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";
import { capitalize, getCostTypeColor } from "../shared";
import { ChartTooltip, TooltipExpenseBreakdown } from "./ChartTooltip";
import { ChartEmpty } from "./chart-empty";

type DonutDatum = {
  id: string;
  label: string;
  value: number;
  color: string;
};

export function ExpenseDonut({
  expenses,
  height = 350,
  centerLabel = "Total cost",
  selectedCostType,
  onCostTypeClick,
}: {
  expenses: ExpenseOut[];
  height?: number;
  centerLabel?: string;
  /** Cost-type key to highlight (drill-down selection); center label shows its total. */
  selectedCostType?: string | null;
  /** When set, slices are clickable and report their cost-type key. */
  onCostTypeClick?: (costTypeKey: string) => void;
}) {
  const {
    data,
    total,
    netTotal,
    excludedTotal,
    adjustmentTotal,
    expensesByType,
  } = useMemo(() => {
    const principalExpenses = expenses.filter(isPrincipalExpense);
    const byCostType = sumByKey(
      principalExpenses,
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

    // Expenses behind each slice, for the tooltip's top-3 breakdown.
    const expensesByType = new Map<string, ExpenseOut[]>();
    for (const p of principalExpenses) {
      const key = p.costType ?? "other";
      const list = expensesByType.get(key);
      if (list) list.push(p);
      else expensesByType.set(key, [p]);
    }

    // `total` = the positive-only sum the arcs actually render (used for the
    // slice percentages, which must add to 100%). `netTotal` = the true net of
    // ALL expenses incl. negatives — this is what the center number shows so it
    // reconciles with the StatTile "Total cost".
    const total = sumBy(data, (d) => d.value);
    const netTotal = sumBy(expenses, (p) => p.cost ?? 0);
    const adjustmentTotal = sumBy(
      expenses.filter((expense) => !isPrincipalExpense(expense)),
      (expense) => expense.cost ?? 0,
    );
    // Exact sum of the non-positive cost-type buckets the ring can't draw
    // (computed from the buckets, not `netTotal - total`, to avoid float
    // residue falsely reporting a "$0" exclusion when every bucket is positive).
    const excludedTotal = sumBy(
      Array.from(byCostType.values()).filter((v) => v <= 0),
      (v) => v,
    );
    return {
      data,
      total,
      netTotal,
      excludedTotal,
      adjustmentTotal,
      expensesByType,
    };
  }, [expenses]);

  if (data.length === 0) {
    return (
      <Stack gap="tight">
        <ChartEmpty icon={ShoppingBag} title="No principal expense data." />
        {adjustmentTotal !== 0 ? (
          <p className="text-center text-muted-foreground text-xs">
            Total spend is {formatCurrency(adjustmentTotal, 0)} in purchase
            adjustments, with no principal category slices.
          </p>
        ) : null}
      </Stack>
    );
  }

  const selected =
    selectedCostType != null
      ? data.find((d) => d.id === selectedCostType)
      : undefined;
  const centerValue = selected?.value ?? netTotal;
  const centerText = selected ? selected.label : centerLabel;

  // Only meaningful when nothing is drilled in: the arcs are positive-only, so
  // a net-reducing bucket (refunds/credits) is absent from the ring but still
  // folded into the center's net total. Caption reconciles the two.
  const showExcludedCaption = !selected && excludedTotal < 0;

  return (
    <Stack gap="tight">
      <div
        style={{ height }}
        className={onCostTypeClick ? "[&_path]:cursor-pointer" : undefined}
      >
        <ResponsivePie
          {...nivoMotion}
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
              <TooltipExpenseBreakdown
                expenses={expensesByType.get(String(datum.id)) ?? []}
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
      {showExcludedCaption && (
        <p className="text-center text-muted-foreground text-xs">
          Ring shows {formatCurrency(total, 0)} positive spend; center is the
          net total, which excludes {formatCurrency(Math.abs(excludedTotal), 0)}{" "}
          in refunds/credits.
        </p>
      )}
      {!selected && adjustmentTotal !== 0 && (
        <p className="text-center text-muted-foreground text-xs">
          Total includes {formatCurrency(adjustmentTotal, 0)} in purchase
          adjustments not assigned to a category slice.
        </p>
      )}
    </Stack>
  );
}
