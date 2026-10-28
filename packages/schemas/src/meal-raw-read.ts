/** Repository/compiler projections. Public Meal reads use generated envelopes. */
import { readSchemas as definitionSchemas } from "./entity-definitions/06-meal.entity";
import { z } from "zod";
import { rawMealRecipeOut } from "./meal-fields";
import { mealShortcode } from "./identifier-fields";
import { mealDate } from "./meal-shared";
import { mealTypeSchema, mealKindSchema } from "./meal-classification";
import { mealTotals } from "./meal-fields";

export {
  rawMealRecipeOut,
  rawMealRecipeSummary,
  type RawMealRecipeOut,
} from "./meal-fields";
export const rawMealOutput = definitionSchemas.output;
export const rawMealList = definitionSchemas.list;
export const rawMealDetail = definitionSchemas.detail;
const mcpRecipes = z.array(rawMealRecipeOut.omit({ id: true }));
export const rawMealMcpOutput = rawMealOutput.extend({ recipes: mcpRecipes });
export const rawMealMcpList = rawMealList.extend({ recipes: mcpRecipes });
export const rawMealMcpDetail = rawMealDetail.extend({ recipes: mcpRecipes });
export type RawMealOutput = z.output<typeof rawMealOutput>;
export type RawMealList = z.output<typeof rawMealList>;
export type RawMealDetail = z.output<typeof rawMealDetail>;
export const rawUpcomingMealSummary = z.object({
  id: mealShortcode,
  date: mealDate,
  name: z.string().nullable(),
  mealType: mealTypeSchema.nullable(),
  mealKind: mealKindSchema,
  totals: mealTotals,
});
export type RawUpcomingMealSummary = z.output<typeof rawUpcomingMealSummary>;
