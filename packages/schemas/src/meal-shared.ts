import { z } from "zod";
import { plainDate } from "./base-entity";

export const mealScale = z.number().min(0.01).max(1000);

/** Authored gram measurements are stored as positive whole grams. */
export const mealYieldGrams = z.number().int().positive();
export type MealYieldGrams = z.infer<typeof mealYieldGrams>;

export const mealDate = plainDate;

export const mealDateRange = z.object({ from: mealDate, to: mealDate });
