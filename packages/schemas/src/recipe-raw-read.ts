/** Repository/compiler projections. Public Recipe reads use generated envelopes. */
import { readSchemas as definitionSchemas } from "./entity-definitions/01-recipe.entity";
import { z } from "zod";
import { displayImagesField } from "./display-images";
import { imageUrlSummary } from "./image-summary";
import {
  ingredientSectionLineOut,
  recipeSectionIngredientOut,
  recipeSectionLineOut,
  recipeSectionOut,
} from "./recipe-fields";
import { rawRecipeTopLevel, recipeTotals } from "./recipe-shared";

export const rawRecipeOutput = definitionSchemas.output.extend({
  displayImages: displayImagesField.optional(),
});
export const rawRecipeList = definitionSchemas.list;
const rawRecipeMcpSection = recipeSectionOut
  .omit({ id: true, ingredients: true })
  .extend({
    ingredients: z.array(
      z.discriminatedUnion("type", [
        ingredientSectionLineOut.omit({ id: true }),
        recipeSectionLineOut.omit({ id: true }),
      ]),
    ),
  });
export const rawRecipeMcpOutput = rawRecipeOutput.extend({
  sections: z.array(rawRecipeMcpSection),
});
export const rawRecipeGraph = rawRecipeTopLevel.extend({
  sections: z.array(recipeSectionOut),
  displayImage: imageUrlSummary.nullable(),
  totals: recipeTotals.nullish(),
});
export const rawRecipeMcpReference = rawRecipeTopLevel.pick({
  id: true,
  name: true,
  yield: true,
  servings: true,
  tags: true,
});
export type RawRecipeOutput = z.output<typeof rawRecipeOutput>;
export type RawRecipeList = z.output<typeof rawRecipeList>;
export type RawRecipeGraph = z.output<typeof rawRecipeGraph>;
export type { RawRecipeTopLevel } from "./recipe-shared";
export type RawRecipeSection = z.output<typeof recipeSectionOut>;
export type RawSectionIngredient = z.output<typeof recipeSectionIngredientOut>;

export const rawSectionIngredient = recipeSectionIngredientOut;
