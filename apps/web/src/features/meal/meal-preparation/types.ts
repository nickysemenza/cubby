import type {
  GetMealPreparationsOut,
  MealRecipePreparationPortionOut,
  SaveMealRecipePreparationInput,
} from "@cubby/schemas/meal";
import type { MealKind } from "@cubby/schemas/meal-classification";

import { formatCalendarDay } from "~/lib/date-format";

type MealPreparationPortion = MealRecipePreparationPortionOut;
export type MealPreparation = GetMealPreparationsOut["preparations"][number];
export type MealPreparationsView = GetMealPreparationsOut;
export type PreparationTargetOption = MealPreparationPortion["targetMeal"] & {
  mealKind: MealKind | null;
};

export type PreparationEaterOption = MealPreparationPortion["eater"];
export type PreparationSaveRequest = SaveMealRecipePreparationInput;

export function mealLabel(meal: PreparationTargetOption): string {
  const day = formatCalendarDay(meal.date, "monthDay");
  return meal.name ? `${meal.name} · ${day}` : day;
}
