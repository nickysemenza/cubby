import type {
  GetMealPreparationsOut,
  MealPreparationCalorieEstimate,
  MealRecipePreparationPortionOut,
  SaveMealRecipePreparationInput,
} from "@cubby/schemas/meal";

/**
 * The preparation UI deliberately consumes the detail operation's view model,
 * rather than MealRecipeOut.  A MealRecipe is still a planning row; this
 * shape adds the measured batch and its portions without pretending that
 * portions are inventory movements.
 */
export type CalorieCoverage = MealPreparationCalorieEstimate;
type MealPreparationPortion = MealRecipePreparationPortionOut;
export type MealPreparation = GetMealPreparationsOut["preparations"][number];
export type MealPreparationsView = GetMealPreparationsOut;
export type PreparationTargetOption = MealPreparationPortion["targetMeal"];
export type PreparationEaterOption = MealPreparationPortion["eater"];
export type PreparationSaveRequest = SaveMealRecipePreparationInput;

export function calorieText(coverage: CalorieCoverage): string {
  switch (coverage.status) {
    case "pending":
      return "Calories pending";
    case "unavailable":
      return "Calories unavailable";
    case "partial":
      return `At least ${Math.round(coverage.lower)} kcal`;
    case "complete":
      return coverage.upper == null || coverage.lower === coverage.upper
        ? `${Math.round(coverage.lower)} kcal`
        : `${Math.round(coverage.lower)}–${Math.round(coverage.upper)} kcal`;
  }
}

export function calorieTone(
  coverage: CalorieCoverage,
): "outline" | "warning" | "positive" {
  switch (coverage.status) {
    case "complete":
      return "positive";
    case "partial":
      return "warning";
    default:
      return "outline";
  }
}

export function mealLabel(meal: PreparationTargetOption): string {
  const date = new Date(`${meal.date}T12:00:00`);
  const day = Number.isNaN(date.valueOf())
    ? meal.date
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return meal.name ? `${meal.name} · ${day}` : day;
}
