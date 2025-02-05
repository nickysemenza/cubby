import { z } from "zod";
import { dbTimestamps } from "./util";
import { amount } from "~/codec/codec";

const ingredientOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(dbTimestamps);
export const recipeTopLevel = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .merge(dbTimestamps);
const sectionIngredientOut = z
  .object({
    id: z.string().uuid(),
    recipe: recipeTopLevel.nullable(),
    ingredient: ingredientOut.nullable(),
    amounts: z.array(amount),
  })
  .merge(dbTimestamps);
export type SectionIngredient = z.infer<typeof sectionIngredientOut>;
const recipeSectionOut = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
    instructions: z.array(z.object({ instruction: z.string() })),
  })
  .merge(dbTimestamps);

export const recipeOut = z
  .object({
    sections: z.array(recipeSectionOut),
  })
  .merge(recipeTopLevel);

export type RecipeOut = z.infer<typeof recipeOut>;
