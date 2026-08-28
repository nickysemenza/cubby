import type { IngredientAvailabilityStatus } from "@cubby/schemas/availability";
import type { MealTotals } from "@cubby/schemas/meal";
import {
  MEAL_TYPE_LABELS,
  type MealType,
} from "@cubby/schemas/meal-classification";
import { format, parseISO } from "date-fns";

import {
  tryFormatAmount,
  tryFormatAmountShopper,
} from "~/app/_components/inventory/format-amount";
import { formatCurrency } from "~/lib/utils";

import type { ShoppingRow } from "./shopping-model";

/**
 * Format a shopping-list need/have/shortfall amount, via the same WASM
 * formatter every other amount surface uses (`tryFormatAmount`) — this used
 * to hand-round with `Math.round(value * 100) / 100` and string-concat the
 * unit, which bypassed the engine's range/"each" handling and rendered by a
 * different rule than the rest of the app.
 *
 * `basisUnit` is `null` (or, per `availability.rs`'s "needs nothing" group,
 * `""`) when there's no unit to report; WASM's own bare-count sentinel unit
 * ("whole") renders the value with no unit suffix (see
 * format-amount.unit.test.ts's "bare-count" cases), so falling back to it
 * here reuses that behavior instead of re-deriving it.
 */
export const formatAmount = (value: number, unit: string | null): string =>
  tryFormatAmount({ value, unit: unit || "whole" });

/**
 * The shopping-list spelling of an amount: the same WASM formatter, laddered
 * into shop units.
 *
 * Reserved for the SHORTFALL — the quantity you actually carry to a shop.
 * Need, have, and the per-meal cells stay in the engine's basis unit on
 * purpose: the ladder is a per-value threshold, so laddering them too would
 * let one row read "need 300 g / have 1.1 lb", trading a unit that's merely
 * unfriendly for two that disagree.
 */
const formatShopperAmount = (value: number, unit: string | null): string =>
  tryFormatAmountShopper({ value, unit: unit || "whole" });

/**
 * How an unnamed meal identifies itself — by its day. Shared so the table's
 * Name column, its delete dialog, and the Problems section can't disagree
 * about what a nameless row is called.
 */
export const mealDateLabel = (meal: { date: string }): string =>
  format(parseISO(meal.date), "EEE, MMM d");

/**
 * How a meal names itself in a list: its own name, else what's planned in it,
 * else its slot, else the day.
 *
 * The slot step is why this is shared rather than re-inlined. Three surfaces
 * had grown their own version ending in a bare "Untitled meal", which is
 * exactly wrong for the common recipe-less case — an eating-out dinner is not
 * untitled, it's dinner. Matches the calendar title's own fallback order.
 */
export const mealListLabel = (meal: {
  name: string | null;
  date: string;
  mealType: MealType | null;
  recipes?: { recipe: { name: string } }[];
}): string =>
  meal.name ||
  (meal.recipes ?? []).map((r) => r.recipe.name).join(", ") ||
  (meal.mealType ? MEAL_TYPE_LABELS[meal.mealType] : "") ||
  mealDateLabel(meal);

/** Meal/day cost rollup as a short string; "—" when no recipe has totals. */
export const formatMealCost = (totals: MealTotals): string => {
  if (totals.pending && totals.costTotal === 0) return "—";
  const base = formatCurrency(totals.costTotal);
  return totals.pending ? `${base}+` : base;
};

/** Text-color class per availability status (warm semantic tokens). */
export const statusClass = (status: IngredientAvailabilityStatus): string => {
  switch (status) {
    case "ok":
      return "text-positive";
    case "short":
      return "text-warning-ink";
    case "missing":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
};

// The four amount cells every shopping renderer shows. Written once here so
// the table, the mobile card and the matrix can't render the same row by three
// slightly different rules.

export const needText = (row: ShoppingRow): string =>
  formatAmount(row.need, row.item.basisUnit);

export const haveText = (row: ShoppingRow): string =>
  row.item.haveValue == null
    ? "—"
    : formatAmount(row.item.haveValue, row.item.basisUnit);

/** "?" when on-hand is unknown — distinct from a real, covered zero ("✓"). */
export const shortText = (row: ShoppingRow): string => {
  if (row.shortfall == null) return "?";
  return row.shortfall > 0
    ? formatShopperAmount(row.shortfall, row.item.basisUnit)
    : "✓";
};

export const shortClass = (row: ShoppingRow): string =>
  row.shortfall == null || row.shortfall > 0
    ? statusClass(row.status)
    : "text-muted-foreground";

export const statusLabel = (status: IngredientAvailabilityStatus): string => {
  switch (status) {
    case "ok":
      return "Have enough";
    case "short":
      return "Short";
    case "missing":
      return "Need to buy";
    case "unconvertible":
      return "Can't compare units";
    case "subrecipe":
      return "Sub-recipe";
    default:
      return status;
  }
};
