import { z } from "zod";

/**
 * Which eating occasion of the day a meal is.
 *
 * **Declaration order is clock order.** `mealTypeRank` returns the index, and
 * the planning calendar sorts a day's meals by it — so reordering this tuple
 * reorders the calendar. Insert a new slot at the time of day it belongs, not
 * at the end, and give it a matching entry in `MEAL_TYPE_START_MINUTES`; a test
 * asserts the two agree.
 *
 * Nullable on the row: a meal that predates this column, or one planned
 * without a slot in mind, is genuinely unslotted. Backfilling those to
 * `dinner` would invent a fact nobody stated.
 */
export const mealTypeValues = [
  "breakfast",
  "brunch",
  "lunch",
  "snack",
  "dinner",
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

/**
 * Canonical wall-clock start of each slot, in minutes from household-local
 * midnight.
 *
 * Derived, never stored: `Meal.date` is a plain date with no time component, so
 * a meal's time is a property of its *slot* rather than of the row. An
 * unslotted meal has no entry here on purpose — it stays a full-day event
 * rather than being assigned a time nobody chose.
 *
 * Must stay in the same order as `mealTypeValues`, which is that tuple's whole
 * contract.
 */
export const MEAL_TYPE_START_MINUTES: Record<MealType, number> = {
  breakfast: 9 * 60,
  brunch: 11 * 60,
  lunch: 12 * 60,
  snack: 15 * 60,
  dinner: 19 * 60,
  dessert: 20 * 60,
};

/** Every slot is a half-hour block. */
export const MEAL_SLOT_DURATION_MINUTES = 30;

export function mealTypeRank(type: MealType | null | undefined): number {
  if (!type) return mealTypeValues.length;
  return mealTypeValues.indexOf(type);
}

export function contributesToShoppingList(kind: MealKind): boolean {
  return kind === "cooked";
}
