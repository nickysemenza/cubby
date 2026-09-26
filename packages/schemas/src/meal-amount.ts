import { z } from "zod";
import { amount } from "./codec";

/** A logged quantity is a scalar fact; conversions belong to its source. */
export const mealFoodAmount = z.strictObject({
  value: amount.shape.value.finite().positive(),
  unit: amount.shape.unit.trim().min(1),
});
export type MealFoodAmount = z.infer<typeof mealFoodAmount>;
