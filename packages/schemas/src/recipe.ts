import { z } from "zod";
import { amount } from "./codec";
import { requiredName } from "./common";
import { cookbookId, id, ingredientId, recipeId } from "./identifiers";
import { createInputImages, updateInputImages } from "./image";
import {
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeTags,
  recipeYieldSchema,
} from "./recipe-shared";

export * from "./recipe-responses";
export * from "./recipe-shared";

// Schema for recipe mutations
// Raw, unparsed source line + the parser-derived modifier (e.g. "finely
// chopped"). Optional provenance carried through from import so it can be
// persisted on RecipeSectionIngredient; absent on manual/UI edits.
const ingredientProvenance = {
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
};

export const recipeIngredientInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingredient"),
    ingredientId: ingredientId,
    recipeId: z.null(),
    amounts: z.array(amount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeId,
    ingredientId: z.null(),
    amounts: z.array(amount),
    id: id.optional(),
    ...ingredientProvenance,
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

// Descriptions live at the field level here (rather than on the shared building
// blocks, which are also reused by the output/form layers) so they reliably
// Filters accepted by the recipe list endpoint.
export const recipeFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  // Scope the list to one cookbook by FK id (cookbook detail page).
  cookbookId: cookbookId.optional(),
});

// surface to MCP clients via `recipeCreateInput.shape` — see the create_recipe /
// update_recipe tools. `recipeUpdateInput` inherits them through `.partial()`.
export const recipeCreateInput = z
  .object({
    name: requiredName("Recipe name").describe("Recipe name"),
    meta: recipeMeta.describe(
      "Source metadata, e.g. { url } of the web source",
    ),
    yield: recipeYieldSchema
      .nullable()
      .optional()
      .describe('What the recipe produces, e.g. { value: 2, unit: "loaves" }'),
    servings: recipeServings
      .nullable()
      .optional()
      .describe("Number of servings (positive integer)"),
    tags: recipeTags.nullable().optional().describe("Free-form tags"),
    notes: recipeNotes
      .nullable()
      .optional()
      .describe("Freeform markdown headnote/intro plus tips"),
    sections: z
      .array(recipeSectionInput)
      .describe(
        "Recipe sections, each with ingredients (by ingredient/recipe id) and instructions",
      ),
  })
  .extend(createInputImages.shape);

export const recipeUpdateInput = z.object({
  id: recipeId,
  data: recipeCreateInput.partial().extend(updateInputImages.shape),
});

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;
