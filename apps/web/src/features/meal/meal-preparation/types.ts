import type {
  GetMealPreparationsOut,
  MealRecipePreparationPortionOut,
  SaveMealRecipePreparationInput,
} from "@cubby/schemas/meal";

import { formatCalendarDay } from "~/lib/date-format";

type MealPreparationPortion = MealRecipePreparationPortionOut;
export type MealPreparation = GetMealPreparationsOut["preparations"][number];
export type MealPreparationsView = GetMealPreparationsOut;
export type PreparationTargetOption = MealPreparationPortion["targetMeal"];
export type PreparationEaterOption = MealPreparationPortion["eater"];
export type PreparationSaveRequest = SaveMealRecipePreparationInput;

export function mealLabel(meal: PreparationTargetOption): string {
  const day = formatCalendarDay(meal.date, "monthDay");
  return meal.name ? `${meal.name} · ${day}` : day;
}
