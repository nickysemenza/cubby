import { z } from "zod";
import { amount } from "./codec";
import { baseEntitySchema, dbTimestampsOut } from "./common";
import { id, ingredientId, recipeId } from "./identifiers";
import { createInputImages, imageOut, updateInputImages } from "./image";

// Recipe source values - single source of truth for both Zod and Drizzle
export const recipeSourceValues = ["Book", "Website", "Other"] as const;

// Recipe yield schema - what the recipe produces
export const recipeYieldSchema = z.object({
  value: z.number().positive(),
  unit: z.string().min(1),
});
export type RecipeYield = z.infer<typeof recipeYieldSchema>;

const ingredientOut = baseEntitySchema;

export const recipeTopLevel = baseEntitySchema.extend({
  meta: z
    .object({
      url: z.url().nullable(),
    })
    .nullable(),
  yield: recipeYieldSchema.nullish(),
  servings: z.number().int().positive().nullish(),
  tags: z.array(z.string()).nullish(),
});

// Create a base schema with common fields
const sectioningredientOut = z
  .object({
    id: z.uuid(),
    amounts: z.array(amount),
  })
  .extend(dbTimestampsOut.shape);

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
    id: z.uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
    instructions: z.array(z.object({ instruction: z.string() })),
  })
  .extend(dbTimestampsOut.shape);

export type SectionIngredientOut = z.infer<typeof sectionIngredientOut>;

export const recipeOut = z
  .object({
    sections: z.array(recipeSectionOut),
    images: z.array(imageOut).default([]),
  })
  .extend(recipeTopLevel.shape);

export type RecipeOut = z.infer<typeof recipeOut>;

export type SectionIngredientType = z.infer<
  typeof sectionIngredientOut
>["type"];

// Schema for recipe mutations
export const recipeIngredientInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingredient"),
    ingredientId: ingredientId,
    recipeId: z.null(),
    amounts: z.array(amount),
    id: id.optional(),
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeId,
    ingredientId: z.null(),
    amounts: z.array(amount),
    id: id.optional(),
  }),
]);
export type RecipeIngredientInput = z.infer<typeof recipeIngredientInput>;

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
    yield: recipeYieldSchema.nullable().optional(),
    servings: z.number().int().positive().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    sections: z.array(recipeSectionInput),
  })
  .extend(createInputImages.shape);

export const recipeUpdateInput = z.object({
  id: recipeId,
  data: recipeCreateInput.partial().extend(updateInputImages.shape),
});

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;
