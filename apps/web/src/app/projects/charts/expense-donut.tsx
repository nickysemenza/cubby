import { isPrincipalExpense } from "@cubby/schemas/expense-line-kind";
import type { ExpenseOut } from "@cubby/schemas/project";
import { ShoppingBagIcon } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { sumBy } from "es-toolkit";
import { useMemo } from "react";

import { CategoryDonut } from "~/app/_components/charts/kit";
import { Stack } from "~/components/layout";
import { formatCurrency } from "~/lib/utils";
import { sumByKey } from "~/misc/array-helpers";

import { capitalize, getCostTypeColor } from "../shared";
import { ChartEmpty } from "./chart-empty";
import { TooltipExpenseBreakdown } from "./ChartTooltip";

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

    const data = Array.from(byCostType.entries())
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

    // `netTotal` = the true net of ALL expenses incl. negatives — this is what
    // the center number shows so it reconciles with the StatTile "Total cost".
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
    const total = sumBy(data, (d) => d.value);
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
        <ChartEmpty icon={ShoppingBagIcon} title="No principal expense data." />
        {adjustmentTotal !== 0 ? (
          <p className="text-center text-xs text-muted-foreground">
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
  // Only meaningful when nothing is drilled in: the arcs are positive-only, so
  // a net-reducing bucket (refunds/credits) is absent from the ring but still
  // folded into the center's net total. Caption reconciles the two.
  const showExcludedCaption = !selected && excludedTotal < 0;

  return (
    <Stack gap="tight">
      <CategoryDonut
        data={data}
        height={height}
        centerValue={netTotal}
        centerLabel={centerLabel}
        selectedId={selectedCostType}
        onSelect={onCostTypeClick}
        renderTooltipExtra={(id) => (
          <TooltipExpenseBreakdown expenses={expensesByType.get(id) ?? []} />
        )}
        emptyIcon={ShoppingBagIcon}
        emptyTitle="No principal expense data."
      />
      {showExcludedCaption && (
        <p className="text-center text-xs text-muted-foreground">
          Ring shows {formatCurrency(total, 0)} positive spend; center is the
          net total, which excludes {formatCurrency(Math.abs(excludedTotal), 0)}{" "}
          in refunds/credits.
        </p>
      )}
      {!selected && adjustmentTotal !== 0 && (
        <p className="text-center text-xs text-muted-foreground">
          Total includes {formatCurrency(adjustmentTotal, 0)} in purchase
          adjustments not assigned to a category slice.
        </p>
      )}
    </Stack>
  );
}
