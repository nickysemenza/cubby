import { type db } from "../db";
import { type ParsedCompactRecipe } from "~/codec/codec";
import { findOrCreateIngredient } from "./ingredient";
import { RecipeCreateInput } from "~/schemas/recipe";
import { createRecipe } from "./recipe";

export const upsertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  prismaClient: typeof db,
) => {
  const i: RecipeCreateInput = {
    name: recipe.name,
    meta: {
      url: recipe.meta?.url ?? null,
    },
    sections: await Promise.all(
      recipe.sections.map(async (section) => ({
        instructions: section.instructions.map((instruction) => ({
          instruction,
        })),
        ingredients: await Promise.all(
          section.ingredients.map(async (ingredient) => {
            const newIngredient = await findOrCreateIngredient(
              prismaClient,
              ingredient.name,
            );
            return {
              type: "ingredient" as const,
              ingredientId: newIngredient.id,
              recipeId: null,
              amounts: ingredient.amounts,
            };
          }),
        ),
      })),
    ),
  };

  const newRecipe = await createRecipe(i, prismaClient);
  return { id: newRecipe.id };
};
