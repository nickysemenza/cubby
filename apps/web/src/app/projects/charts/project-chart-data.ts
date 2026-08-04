import type { ExpenseOut } from "@cubby/schemas/project";
import { sumBy } from "es-toolkit";
import { monthKey, monthLabel } from "../shared";

export interface ExpenseSeries {
  id: string;
  data: Array<{ x: string; y: number }>;
}

export function buildExpenseCalendar(expenses: ExpenseOut[]) {
  const itemsByDay = new Map<string, ExpenseOut[]>();
  for (const expense of expenses) {
    // Match the existing heatmap: zero-value rows do not create a clickable day.
    if (!expense.date || !expense.cost) continue;
    const items = itemsByDay.get(expense.date) ?? [];
    items.push(expense);
    itemsByDay.set(expense.date, items);
  }
  const data = Array.from(itemsByDay, ([day, items]) => ({
    day,
    value: sumBy(items, (expense) => expense.cost ?? 0),
  }));
  const dates = data.map(({ day }) => day).sort();
  return {
    data,
    from: dates[0] ?? "",
    to: dates.at(-1) ?? "",
    itemsByDay,
  };
}

export function buildCumulativeSpendPoints(expenses: ExpenseOut[]) {
  let cumulative = 0;
  return expenses
    .filter((expense) => expense.date && expense.cost != null)
    .sort((a, b) => a.date!.localeCompare(b.date!))
    .map((expense) => {
      cumulative += expense.cost!;
      return { x: expense.date!, y: cumulative };
    });
}

function buildMonthlySeries(
  expenses: ExpenseOut[],
  groupFor: (expense: ExpenseOut) => string,
  cumulative: boolean,
  minimumMonths: number,
): ExpenseSeries[] {
  const months = new Set<string>();
  const grouped = new Map<string, Map<string, number>>();
  for (const expense of expenses) {
    if (!expense.date || expense.cost == null) continue;
    const group = groupFor(expense);
    const month = monthKey(expense.date);
    months.add(month);
    const totals = grouped.get(group) ?? new Map<string, number>();
    totals.set(month, (totals.get(month) ?? 0) + expense.cost);
    grouped.set(group, totals);
  }
  const sortedMonths = Array.from(months).sort();
  if (sortedMonths.length < minimumMonths) return [];

  return Array.from(grouped, ([id, totals]) => {
    let runningTotal = 0;
    return {
      id,
      data: sortedMonths.map((month) => {
        const value = totals.get(month) ?? 0;
        if (cumulative) runningTotal += value;
        return { x: monthLabel(month), y: cumulative ? runningTotal : value };
      }),
    };
  }).sort(
    (a, b) =>
      b.data.reduce((total, point) => total + point.y, 0) -
      a.data.reduce((total, point) => total + point.y, 0),
  );
}

export function buildStackedCumulativeSpend(
  expenses: ExpenseOut[],
  groupFor: (expense: ExpenseOut) => string,
) {
  return buildMonthlySeries(expenses, groupFor, true, 1).sort(
    (a, b) => (b.data.at(-1)?.y ?? 0) - (a.data.at(-1)?.y ?? 0),
  );
}
