import type {
  GetMealPreparationsOut,
  MealRecipePreparationPortionOut,
  SaveMealRecipePreparationInput,
} from "@cubby/schemas/meal";

type MealPreparationPortion = MealRecipePreparationPortionOut;
export type MealPreparation = GetMealPreparationsOut["preparations"][number];
export type MealPreparationsView = GetMealPreparationsOut;
export type PreparationTargetOption = MealPreparationPortion["targetMeal"];
export type PreparationEaterOption = MealPreparationPortion["eater"];
export type PreparationSaveRequest = SaveMealRecipePreparationInput;

export function mealLabel(meal: PreparationTargetOption): string {
  const date = new Date(`${meal.date}T12:00:00`);
  const day = Number.isNaN(date.valueOf())
    ? meal.date
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return meal.name ? `${meal.name} · ${day}` : day;
}
