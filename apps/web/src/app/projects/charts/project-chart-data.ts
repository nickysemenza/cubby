import type { PurchaseOut } from "@cubby/schemas/project";
import { monthKey, monthLabel } from "../shared";

export interface PurchaseSeries {
  id: string;
  data: Array<{ x: string; y: number }>;
}

export function buildPurchaseCalendar(purchases: PurchaseOut[]) {
  const itemsByDay = new Map<string, PurchaseOut[]>();
  for (const purchase of purchases) {
    // Match the existing heatmap: zero-value rows do not create a clickable day.
    if (!purchase.date || !purchase.cost) continue;
    const items = itemsByDay.get(purchase.date) ?? [];
    items.push(purchase);
    itemsByDay.set(purchase.date, items);
  }
  const data = Array.from(itemsByDay, ([day, items]) => ({
    day,
    value: items.reduce((total, purchase) => total + (purchase.cost ?? 0), 0),
  }));
  const dates = data.map(({ day }) => day).sort();
  return {
    data,
    from: dates[0] ?? "",
    to: dates.at(-1) ?? "",
    itemsByDay,
  };
}

export function buildCumulativeSpendPoints(purchases: PurchaseOut[]) {
  let cumulative = 0;
  return purchases
    .filter((purchase) => purchase.date && purchase.cost != null)
    .sort((a, b) => a.date!.localeCompare(b.date!))
    .map((purchase) => {
      cumulative += purchase.cost!;
      return { x: purchase.date!, y: cumulative };
    });
}

function buildMonthlySeries(
  purchases: PurchaseOut[],
  groupFor: (purchase: PurchaseOut) => string,
  cumulative: boolean,
  minimumMonths: number,
): PurchaseSeries[] {
  const months = new Set<string>();
  const grouped = new Map<string, Map<string, number>>();
  for (const purchase of purchases) {
    if (!purchase.date || purchase.cost == null) continue;
    const group = groupFor(purchase);
    const month = monthKey(purchase.date);
    months.add(month);
    const totals = grouped.get(group) ?? new Map<string, number>();
    totals.set(month, (totals.get(month) ?? 0) + purchase.cost);
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
  purchases: PurchaseOut[],
  groupFor: (purchase: PurchaseOut) => string,
) {
  return buildMonthlySeries(purchases, groupFor, true, 1).sort(
    (a, b) => (b.data.at(-1)?.y ?? 0) - (a.data.at(-1)?.y ?? 0),
  );
}

export function buildProjectMonthlySeries(purchases: PurchaseOut[]) {
  return buildMonthlySeries(
    purchases,
    (purchase) => purchase.projectName ?? "Unassigned",
    false,
    2,
  );
}
