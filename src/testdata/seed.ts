import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./fakeRecipes";
import { upsertRecipeFromCompact } from "~/server/compactrecipe";
import { getRecipeByID } from "~/server/api/routers/recipe";
import { type PrismaClient } from "@prisma/client";
import { exampleIngredients } from "./ingredients";
import { findOrCreateIngredient } from "~/server/api/routers/ingredients";

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
