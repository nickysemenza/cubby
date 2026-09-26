import { z } from "zod";
import { mealFoodAmount } from "./meal-amount";
import { nutrientKey } from "./nutrition";
import {
  ledgerPartyShortcode,
  ingredientShortcode,
  mealFoodEntryId,
  mealRecipeId,
  mealShortcode,
  productShortcode,
  recipeShortcode,
} from "./identifiers";
import { mealDate } from "./meal-shared";
import { generatedMealFieldSchemas } from "./generated/entity-field-schemas.meal.gen";
import { nutritionTotals, measureEstimate } from "./nutrition";

export const mealFoodNutrients = z
  .partialRecord(nutrientKey, z.number().nonnegative())
  .refine(
    (values) => Object.values(values).some((value) => value != null),
    "Enter at least one nutrient",
  );
export type MealFoodNutrients = z.infer<typeof mealFoodNutrients>;
const foodEntryCommon = {
  id: mealFoodEntryId.optional(),
  mealId: mealShortcode,
  ledgerPartyId: ledgerPartyShortcode,
};
export const saveMealFoodInput = z.discriminatedUnion("sourceKind", [
  z.object({
    ...foodEntryCommon,
    sourceKind: z.literal("product"),
    productId: productShortcode,
    amount: mealFoodAmount,
  }),
  z.object({
    ...foodEntryCommon,
    sourceKind: z.literal("ingredient"),
    ingredientId: ingredientShortcode,
    amount: mealFoodAmount,
  }),
  z.object({
    ...foodEntryCommon,
    sourceKind: z.literal("manual"),
    name: z.string().trim().min(1).max(200),
    nutrients: mealFoodNutrients,
    amount: mealFoodAmount.nullable().optional(),
  }),
]);
export type SaveMealFoodInput = z.infer<typeof saveMealFoodInput>;
export const removeMealFoodInput = z.object({
  mealId: mealShortcode,
  id: mealFoodEntryId,
});
export const mealFoodMutationOut = z.object({
  mealId: mealShortcode,
  id: mealFoodEntryId,
});
export const mealNutritionInput = z.union([
  z.object({ mealId: mealShortcode }),
  z.object({ date: z.iso.date() }),
]);
export type MealNutritionInput = z.infer<typeof mealNutritionInput>;
export const nutritionMeal = z.object({
  id: mealShortcode,
  date: mealDate,
  name: generatedMealFieldSchemas.read.name,
  mealType: generatedMealFieldSchemas.read.mealType,
});
const foodCommon = {
  meal: nutritionMeal,
  name: z.string(),
  amount: mealFoodAmount.nullable(),
  grams: z.number().positive().nullable(),
  weight: measureEstimate,
  batchShare: measureEstimate,
  totals: nutritionTotals,
};
export const mealNutritionFood = z.discriminatedUnion("sourceKind", [
  z.object({
    ...foodCommon,
    sourceKind: z.literal("ingredient"),
    id: mealFoodEntryId,
    ingredientId: ingredientShortcode,
  }),
  z.object({
    ...foodCommon,
    sourceKind: z.literal("recipe"),
    mealRecipeId,
    recipeId: recipeShortcode,
    sourceMealId: mealShortcode,
  }),
  z.object({
    ...foodCommon,
    sourceKind: z.literal("product"),
    id: mealFoodEntryId,
    productId: productShortcode,
  }),
  z.object({
    ...foodCommon,
    sourceKind: z.literal("manual"),
    id: mealFoodEntryId,
    nutrients: mealFoodNutrients,
  }),
]);
export type MealNutritionFood = z.infer<typeof mealNutritionFood>;
export const mealNutritionPerson = z.object({
  eater: z.object({ id: ledgerPartyShortcode, name: z.string() }),
  totals: nutritionTotals,
  meals: z.array(z.object({ meal: nutritionMeal, totals: nutritionTotals })),
  foods: z.array(mealNutritionFood),
});
export type MealNutritionPerson = z.infer<typeof mealNutritionPerson>;
export const mealNutritionOut = z.object({
  meals: z.array(nutritionMeal),
  people: z.array(mealNutritionPerson),
});
export type MealNutritionOut = z.infer<typeof mealNutritionOut>;
