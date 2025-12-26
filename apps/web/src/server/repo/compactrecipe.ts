import type { Database } from "../db";
import type { ParsedCompactRecipe } from "~/codec/codec";
import { findOrCreateIngredient } from "./ingredient";
import type { RecipeCreateInput } from "~/schemas/recipe";
import { upsertRecipe } from "./recipe";
import { unsafeIngredientId, type OrganizationId } from "~/schemas/identifiers";
import { withTransaction } from "./database-helpers";
import type { ActorContext } from "~/schemas/context";

// Convert ParsedCompactRecipe to RecipeCreateInput format
const convertParsedCompactToRecipeInput = async (
  recipe: ParsedCompactRecipe,
  db: Database,
  organizationId: OrganizationId,
): Promise<RecipeCreateInput> => {
  return await withTransaction(db, async (tx) => {
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
                tx,
                ingredient.name,
                undefined,
                organizationId,
              );
              return {
                type: "ingredient" as const,
                ingredientId: unsafeIngredientId(newIngredient.id),
                recipeId: null,
                amounts: ingredient.amounts,
              };
            }),
          ),
        })),
      ),
    };
  });
};

export const upsertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  db: Database,
  actor: ActorContext,
) => {
  const { organizationId } = actor;
  // Convert compact recipe format to standard recipe input format
  const recipeInput = await convertParsedCompactToRecipeInput(
    recipe,
    db,
    organizationId,
  );

  // Use the centralized upsert logic
  return await upsertRecipe(recipeInput, db, actor);
};
