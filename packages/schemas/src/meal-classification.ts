import { z } from "zod";

/**
 * Which eating occasion of the day a meal is.
 *
 * **Declaration order is the slot order.** `mealTypeRank` returns the index,
 * and the planning calendar sorts a day's meals by it — so reordering this
 * tuple reorders the calendar. Append new slots at the position they belong in
 * the day, not at the end.
 *
 * Nullable on the row: a meal that predates this column, or one planned
 * without a slot in mind, is genuinely unslotted. Backfilling those to
 * `dinner` would invent a fact nobody stated.
 */
export const mealTypeValues = [
  "breakfast",
  "brunch",
  "lunch",
  "dinner",
  "snack",
  "dessert",
] as const;

export const mealTypeSchema = z.enum(mealTypeValues);
export type MealType = z.infer<typeof mealTypeSchema>;

/**
 * How the meal gets eaten — orthogonal to `mealType`, so "dinner, eating out"
 * is expressible. This is what separates an *intentionally* recipe-less meal
 * from one whose recipes simply haven't been added yet; zero-recipe meals were
 * always legal, but until now nothing said which of the two a given one was.
 *
 * Only `cooked` contributes to the shopping list. A `leftovers` night that
 * still points at its original recipe would otherwise buy every ingredient a
 * second time, and the eating-out kinds carry no recipes to aggregate anyway.
 *
 * `cooked` is the NOT NULL default because it is true of every meal that
 * existed before this column — a real value, not a placeholder standing in for
 * "unknown".
 */
export const mealKindValues = [
  "cooked",
  "leftovers",
  "eating_out",
  "takeout",
  "other",
] as const;

export const mealKindSchema = z.enum(mealKindValues);
export type MealKind = z.infer<typeof mealKindSchema>;

/** Display text. Never capitalize a raw slug — `eating_out` has no nice form. */
export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  brunch: "Brunch",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  dessert: "Dessert",
};

export const MEAL_KIND_LABELS: Record<MealKind, string> = {
  cooked: "Cooked",
  leftovers: "Leftovers",
  eating_out: "Eating out",
  takeout: "Takeout / delivery",
  other: "Other",
};

export function mealTypeRank(type: MealType | null | undefined): number {
  if (!type) return mealTypeValues.length;
  return mealTypeValues.indexOf(type);
}

export function contributesToShoppingList(kind: MealKind): boolean {
  return kind === "cooked";
}
