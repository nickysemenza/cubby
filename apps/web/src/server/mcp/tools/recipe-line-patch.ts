import { positiveAmount } from "@cubby/schemas/codec";
import type {
  recipeOut,
  recipeIngredientInput,
  recipeUpdateData,
} from "@cubby/schemas/recipe";
import { z } from "zod";

import { createAppError } from "~/server/errors/app-error";

import { idParam } from "./tool-input";

type RecipeDetail = z.infer<typeof recipeOut>;
type LineInput = z.infer<typeof recipeIngredientInput>;
type SectionsUpdate = NonNullable<z.infer<typeof recipeUpdateData>["sections"]>;

export const recipeLinePatchFields = z
  .object({
    amounts: z
      .array(positiveAmount)
      .min(1)
      .optional()
      .describe('Replacement amounts, e.g. [{ value: 150, unit: "g" }]'),
    ingredientId: idParam("ingredient")
      .optional()
      .describe("Point the line at this ingredient instead"),
    subRecipeId: idParam("recipe")
      .optional()
      .describe("Point the line at this sub-recipe instead"),
    rawLine: z.string().optional().describe("Replacement source line text"),
    modifier: z.string().optional().describe("Replacement prep modifier"),
  })
  .refine((patch) => !(patch.ingredientId && patch.subRecipeId), {
    message: "Give ingredientId or subRecipeId, not both",
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: "Give at least one field to change",
  });
export type RecipeLinePatch = z.infer<typeof recipeLinePatchFields>;

const lineAsInput = (
  line: RecipeDetail["sections"][number]["ingredients"][number],
): LineInput =>
  line.type === "ingredient"
    ? {
        type: "ingredient",
        ingredientId: line.ingredient.id,
        recipeId: null,
        amounts: line.amounts,
        id: line.id,
        rawLine: line.rawLine,
        modifier: line.modifier,
      }
    : {
        type: "recipe",
        recipeId: line.recipe.id,
        ingredientId: null,
        amounts: line.amounts,
        id: line.id,
        rawLine: line.rawLine,
        modifier: line.modifier,
      };

const applyPatch = (line: LineInput, patch: RecipeLinePatch): LineInput => {
  const shared = {
    id: line.id,
    amounts: patch.amounts ?? line.amounts,
    rawLine: patch.rawLine ?? line.rawLine,
    modifier: patch.modifier ?? line.modifier,
  };
  if (patch.ingredientId)
    return {
      ...shared,
      type: "ingredient",
      ingredientId: patch.ingredientId,
      recipeId: null,
    };
  if (patch.subRecipeId)
    return {
      ...shared,
      type: "recipe",
      recipeId: patch.subRecipeId,
      ingredientId: null,
    };
  return line.type === "ingredient"
    ? {
        ...shared,
        type: "ingredient",
        ingredientId: line.ingredientId,
        recipeId: null,
      }
    : {
        ...shared,
        type: "recipe",
        recipeId: line.recipeId,
        ingredientId: null,
      };
};

interface RecipeLinePatchUpdate {
  sections: SectionsUpdate;
  line: LineInput;
}

/**
 * The smallest `sections` update that changes one line. Every section is
 * named by id (an update that omits a section id replaces all sections, and
 * one that omits a named section deletes it); only the line's own section
 * resends its lines, each with its id so the others update in place with
 * their current values. Instructions are left out, so they are untouched.
 */
export function buildRecipeLinePatch(
  recipe: RecipeDetail,
  lineId: string,
  patch: RecipeLinePatch,
): RecipeLinePatchUpdate {
  const located = recipe.sections.flatMap((section) =>
    section.ingredients
      .filter((line) => line.id === lineId)
      .map((line) => ({ section, line })),
  )[0];
  if (!located)
    throw createAppError(
      "RECIPE_NOT_FOUND",
      `Line ${lineId} is not in recipe ${recipe.id}`,
    );
  const { section, line: target } = located;
  const patched = applyPatch(lineAsInput(target), patch);
  const ingredients = section.ingredients.map((line) =>
    line.id === lineId ? patched : lineAsInput(line),
  );
  return {
    sections: recipe.sections.map((candidate) =>
      candidate.id === section.id
        ? { id: candidate.id, ingredients }
        : { id: candidate.id },
    ),
    line: patched,
  };
}
