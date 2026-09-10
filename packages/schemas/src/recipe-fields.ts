import { z } from "zod";
import { id, ingredientShortcode, recipeShortcode } from "./identifiers";
import { amount, positiveAmount } from "./codec";
import { timestampedFields } from "./base-entity";
import { recipeTopLevel } from "./recipe";

const ingredientProvenance = {
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
};

export const recipeIngredientInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingredient"),
    ingredientId: ingredientShortcode,
    recipeId: z.null(),
    amounts: z.array(positiveAmount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeShortcode,
    ingredientId: z.null(),
    amounts: z.array(positiveAmount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
]);

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

export const recipeSectionsInput = z.array(recipeSectionInput);

const sectionLineFields = {
  id: z.uuid(),
  amounts: z.array(amount),
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
  ...timestampedFields,
};
const sectionIngredientRef = z.object({
  id: ingredientShortcode,
  name: z.string(),
  ...timestampedFields,
  aliases: z.array(z.string()).optional(),
});
const ingredientLine = z.object({
  ...sectionLineFields,
  type: z.literal("ingredient"),
  recipe: z.null(),
  ingredient: sectionIngredientRef,
});
const recipeLine = z.object({
  ...sectionLineFields,
  type: z.literal("recipe"),
  recipe: z.lazy(() => recipeTopLevel),
  ingredient: z.null(),
});
export const recipeSectionIngredientOut = z.discriminatedUnion("type", [
  ingredientLine,
  recipeLine,
]);
export const recipeSectionOut = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  instructions: z.array(z.object({ instruction: z.string() })),
  ...timestampedFields,
  ingredients: z.array(recipeSectionIngredientOut),
});
export const recipeSectionsOut = z.array(recipeSectionOut);
