import { type db } from "../db";
import { type ParsedCompactRecipe } from "~/codec/codec";
import { findOrCreateIngredient } from "./ingredient";
import { RecipeCreateInput } from "~/schemas/recipe";
import { upsertRecipe } from "./recipe";

// Convert ParsedCompactRecipe to RecipeCreateInput format
const convertParsedCompactToRecipeInput = async (
  recipe: ParsedCompactRecipe,
  prismaClient: typeof db,
): Promise<RecipeCreateInput> => {
  return {
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
};

export const upsertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  prismaClient: typeof db,
) => {
  // Convert compact recipe format to standard recipe input format
  const recipeInput = await convertParsedCompactToRecipeInput(
    recipe,
    prismaClient,
  );

  // Use the centralized upsert logic
  return await upsertRecipe(recipeInput, prismaClient);
};
