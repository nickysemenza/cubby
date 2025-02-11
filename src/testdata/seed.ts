import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./fakeRecipes";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import { type PrismaClient } from "@prisma/client";
import { exampleIngredients } from "./data-ingredients";
import { getRecipeByID } from "~/server/repo/recipe";
import { findOrCreateIngredient } from "~/server/repo/ingredient";

export const seedRealRecipes = async (db: PrismaClient) => {
  for (const ingredient of exampleIngredients) {
    await findOrCreateIngredient(
      db,
      ingredient.name,
      ingredient.aliases ?? undefined,
    );
  }

  for (const recipe of exampleRecipesCompact) {
    const parsed = parseCompactRecipe(recipe);
    const recipeOut = await upsertRecipeFromCompact(parsed, db);
    const res = await getRecipeByID(recipeOut.id, db);

    if (res === null) {
      throw new Error("Recipe not found");
    }
  }
};
