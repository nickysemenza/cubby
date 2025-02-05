import { z } from "zod";
import { dbTimestampsOut } from "./util";
import { amount } from "~/codec/codec";

const ingredientOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(dbTimestampsOut);
export const recipeTopLevel = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(dbTimestampsOut);
const sectionIngredientOut = z
  .object({
    id: z.string().uuid(),
    recipe: recipeTopLevel.nullable(),
    ingredient: ingredientOut.nullable(),
    amounts: z.array(amount),
  })
  .merge(dbTimestampsOut);
export type SectionIngredient = z.infer<typeof sectionIngredientOut>;
const recipeSectionOut = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
    instructions: z.array(z.object({ instruction: z.string() })),
  })
  .merge(dbTimestampsOut);

export const recipeOut = z
  .object({
    sections: z.array(recipeSectionOut),
  })
  .merge(recipeTopLevel);

export type RecipeOut = z.infer<typeof recipeOut>;
