import { z } from "zod";
import { baseEntitySchema, dbTimestampsOut, id } from "./util";
import { amount } from "~/codec/codec";
import { createInputImages, imageOut, updateInputImages } from "./image";

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
    images: z.array(imageOut).optional(),
  })
  .merge(recipeTopLevel);

export type RecipeOut = z.infer<typeof recipeOut>;

// Schema for recipe mutations
export const recipeIngredientInput = z.object({
  ingredientId: id,
  amounts: z.array(amount),
  id: id.optional(),
});

export const recipeInstructionInput = z.object({
  instruction: z.string(),
  id: id.optional(),
});

export const recipeSectionInput = z.object({
  name: z.string().min(2).nullable().optional(),
  ingredients: z.array(recipeIngredientInput).min(1).optional(),
  instructions: z.array(recipeInstructionInput).min(1).optional(),
  id: id.optional(),
});

export const recipeCreateInput = z
  .object({
    name: z.string(),
    meta: recipeTopLevel.shape.meta,
    sections: z.array(recipeSectionInput),
  })
  .merge(createInputImages);

export const recipeUpdateInput = z.object({
  id: id,
  data: recipeCreateInput.partial().merge(updateInputImages),
});

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;
