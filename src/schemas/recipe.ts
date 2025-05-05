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
    meta: z
      .object({
        url: z.string().nullable(),
      })
      .nullable(),
  })
  .merge(dbTimestampsOut);
// Create a base schema with common fields
const sectionIngredientBase = z
  .object({
    id: z.string().uuid(),
    amounts: z.array(amount),
  })
  .merge(dbTimestampsOut);

// Create a discriminated union to ensure either recipe or ingredient is set
const sectionIngredientOut = z.discriminatedUnion("type", [
  sectionIngredientBase.extend({
    type: z.literal("ingredient"),
    recipe: z.null(),
    ingredient: ingredientOut,
  }),
  sectionIngredientBase.extend({
    type: z.literal("recipe"),
    recipe: recipeTopLevel,
    ingredient: z.null(),
  }),
]);
export type SectionIngredient = z.infer<typeof sectionIngredientOut>;
const recipeSectionOut = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
    instructions: z.array(z.object({ instruction: z.string() })),
  })
  .merge(dbTimestampsOut);
export type SectionIngredientOut = z.infer<typeof sectionIngredientOut>;
export const recipeOut = z
  .object({
    sections: z.array(recipeSectionOut),
  })
  .merge(recipeTopLevel);

export type RecipeOut = z.infer<typeof recipeOut>;
