import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./fakeRecipes";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import { type PrismaClient } from "@prisma/client";
import { getRecipeByID } from "~/server/repo/recipe";

export const seedRealRecipes = async (db: PrismaClient) => {
  for (const recipe of exampleRecipesCompact) {
    const parsed = parseCompactRecipe(recipe);
    const recipeOut = await upsertRecipeFromCompact(parsed, db);
    const res = await getRecipeByID(recipeOut.id, db);

    if (res === null) {
      throw new Error("Recipe not found");
    }
  }
};
