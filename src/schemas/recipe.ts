import { z } from "zod";
import { baseEntitySchema, dbTimestampsOut } from "./util";
import { amount } from "~/codec/codec";

const ingredientOut = baseEntitySchema;

export const recipeTopLevel = baseEntitySchema.extend({
  meta: z
    .object({
      url: z.string().url().nullable(),
    })
    .nullable(),
});

// Create a base schema with common fields
const sectioningredientOut = z
  .object({
    id: z.string().uuid(),
    amounts: z.array(amount),
  })
  .merge(dbTimestampsOut);

// Create a discriminated union to ensure either recipe or ingredient is set
const sectionIngredientOut = z.discriminatedUnion("type", [
  sectioningredientOut.extend({
    type: z.literal("ingredient"),
    recipe: z.null(),
    ingredient: ingredientOut,
  }),
  sectioningredientOut.extend({
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

// Schema for recipe mutations
export const recipeIngredientInput = z.object({
  ingredientId: z.string().uuid(),
  amounts: z.array(amount),
  id: z.string().uuid().optional(),
});

export const recipeInstructionInput = z.object({
  instruction: z.string(),
  id: z.string().uuid().optional(),
});

export const recipeSectionInput = z.object({
  name: z.string().nullable().optional(),
  ingredients: z.array(recipeIngredientInput).optional(),
  instructions: z.array(recipeInstructionInput).optional(),
  id: z.string().uuid().optional(),
});

export const recipeCreateInput = z.object({
  name: z.string(),
  meta: recipeTopLevel.shape.meta,
  sections: z.array(recipeSectionInput),
});

export const recipeUpdateInput = z.object({
  id: z.string().uuid(),
  data: recipeCreateInput.partial(),
});

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;
