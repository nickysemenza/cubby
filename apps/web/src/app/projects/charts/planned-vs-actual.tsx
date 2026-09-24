import { isPrincipalExpense } from "@cubby/schemas/expense-line-kind";
import type { ExpenseOut } from "@cubby/schemas/project";
import { CalendarCheckIcon as CalendarClock } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { useMemo } from "react";

import { formatCurrency } from "~/lib/utils";

import { capitalize } from "../shared";
import { ChartEmpty } from "./chart-empty";
import {
  PlannedActualBar,
  type PlannedActualDatum,
} from "./planned-actual-bar";

/** Committed spend vs actual spend, grouped by cost type. */
export function PlannedVsActual({ expenses }: { expenses: ExpenseOut[] }) {
  const adjustmentTotal = useMemo(
    () =>
      expenses.reduce(
        (total, expense) =>
          isPrincipalExpense(expense) ? total : total + (expense.cost ?? 0),
        0,
      ),
    [expenses],
  );
  const data = useMemo(() => {
    const buckets = new Map<string, { actual: number; planned: number }>();
    for (const expense of expenses) {
      if (!isPrincipalExpense(expense)) continue;
      const costType = expense.costType ?? "uncategorized";
      const entry = buckets.get(costType) ?? { actual: 0, planned: 0 };
      entry[expense.future ? "planned" : "actual"] += expense.cost ?? 0;
      buckets.set(costType, entry);
    }
    return Array.from(buckets.entries())
      .map(([costType, values]): PlannedActualDatum => ({
        category: capitalize(costType),
        ...values,
      }))
      .filter((datum) => datum.actual > 0 || datum.planned > 0)
      .sort(
        (left, right) =>
          left.actual + left.planned - (right.actual + right.planned),
      );
  }, [expenses]);

  if (data.length === 0) {
    return (
      <div>
        <ChartEmpty icon={CalendarClock} title="No principal expense data." />
        {adjustmentTotal !== 0 ? (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Total spend is {formatCurrency(adjustmentTotal, 0)} in purchase
            adjustments, with no principal cost-type bars.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <PlannedActualBar data={data} />
      {adjustmentTotal !== 0 ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Total spend also includes {formatCurrency(adjustmentTotal, 0)} in
          purchase adjustments not assigned to a cost type.
        </p>
      ) : null}
    </div>
  );
}
