import type { ExpenseOut } from "@cubby/schemas/project";
import { CalendarClock } from "lucide-react";
import { useMemo } from "react";
import { capitalize } from "../shared";
import { ChartEmpty } from "./chart-empty";
import {
  PlannedActualBar,
  type PlannedActualDatum,
} from "./planned-actual-bar";

/** Committed spend vs actual spend, grouped by cost type. */
export function PlannedVsActual({ expenses }: { expenses: ExpenseOut[] }) {
  const data = useMemo(() => {
    const buckets = new Map<string, { actual: number; planned: number }>();
    for (const expense of expenses) {
      const costType = expense.costType ?? "uncategorized";
      const entry = buckets.get(costType) ?? { actual: 0, planned: 0 };
      entry[expense.future ? "planned" : "actual"] += expense.cost ?? 0;
      buckets.set(costType, entry);
    }
    return Array.from(buckets.entries())
      .map(
        ([costType, values]): PlannedActualDatum => ({
          category: capitalize(costType),
          ...values,
        }),
      )
      .filter((datum) => datum.actual > 0 || datum.planned > 0)
      .sort(
        (left, right) =>
          left.actual + left.planned - (right.actual + right.planned),
      );
  }, [expenses]);

  if (data.length === 0) {
    return <ChartEmpty icon={CalendarClock} title="No expense data." />;
  }

  return <PlannedActualBar data={data} />;
}
