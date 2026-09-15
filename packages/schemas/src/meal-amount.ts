import { z } from "zod";
import { amount } from "./codec";

/** A logged quantity is a scalar fact; conversions belong to its source. */
export const mealFoodAmount = z.strictObject({
  value: amount.shape.value.finite().positive(),
  unit: amount.shape.unit.trim().min(1),
});
export type MealFoodAmount = z.infer<typeof mealFoodAmount>;

export const mealAmountInputFields = {
  amount: mealFoodAmount.nullable().optional(),
  grams: z.number().finite().positive().nullable().optional(),
};

type AmountInput = {
  amount?: MealFoodAmount | null;
  grams?: number | null;
};

export const hasOneMealAmountInput = (input: AmountInput): boolean =>
  !(input.amount !== undefined && input.grams !== undefined);

/** Expand-migration reader and legacy ingress adapter; never converts units. */
export const mealFoodAmountFromStored = (
  input: AmountInput,
): MealFoodAmount | null =>
  input.amount ??
  (input.grams == null ? null : { value: input.grams, unit: "g" });

export const hasRequiredMealAmount = (input: AmountInput): boolean =>
  hasOneMealAmountInput(input) && mealFoodAmountFromStored(input) !== null;
