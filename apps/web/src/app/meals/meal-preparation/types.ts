import type {
  GetMealPreparationsOut,
  MealPreparationCalorieEstimate,
  MealPreparationEstimate,
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
export type MeasureCoverage = MealPreparationEstimate;
type MealPreparationPortion = MealRecipePreparationPortionOut;
export type MealPreparation = GetMealPreparationsOut["preparations"][number];
export type MealPreparationsView = GetMealPreparationsOut;
export type PreparationTargetOption = MealPreparationPortion["targetMeal"];
export type PreparationEaterOption = MealPreparationPortion["eater"];
export type PreparationSaveRequest = SaveMealRecipePreparationInput;

export function calorieText(coverage: CalorieCoverage): string {
  return measureText(coverage, "calories");
}

export function measureText(
  coverage: MeasureCoverage,
  measure: "cost" | "calories" | "protein",
): string {
  const label =
    measure === "cost"
      ? "Cost"
      : measure === "protein"
        ? "Protein"
        : "Calories";
  const unit =
    measure === "cost" ? "$" : measure === "protein" ? " g" : " kcal";
  const value = (amount: number) =>
    measure === "cost"
      ? `$${amount.toFixed(2)}`
      : `${Math.round(amount)}${unit}`;
  switch (coverage.status) {
    case "pending":
      return `${label} pending`;
    case "unavailable":
      return `${label} unavailable`;
    case "partial":
      return `At least ${value(coverage.lower)}`;
    case "complete":
      return coverage.upper == null || coverage.lower === coverage.upper
        ? value(coverage.lower)
        : `${value(coverage.lower)}–${value(coverage.upper)}`;
  }
}

export function measureTone(
  coverage: MeasureCoverage,
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

export function calorieTone(
  coverage: CalorieCoverage,
): "outline" | "warning" | "positive" {
  return measureTone(coverage);
}

export function mealLabel(meal: PreparationTargetOption): string {
  const date = new Date(`${meal.date}T12:00:00`);
  const day = Number.isNaN(date.valueOf())
    ? meal.date
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return meal.name ? `${meal.name} · ${day}` : day;
}
