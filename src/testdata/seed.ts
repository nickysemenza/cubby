import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./recipes";
import { insertRecipeFromCompact } from "~/server/compactrecipe";
import { getRecipeByID } from "~/server/api/routers/recipe";
import { type PrismaClient } from "@prisma/client";

export const seedRealRecipes = async (db: PrismaClient) => {
  for (const recipe of exampleRecipesCompact) {
    const parsed = parseCompactRecipe(recipe);
    console.log(parsed);
    const id = await insertRecipeFromCompact(parsed, db);
    const res = await getRecipeByID(id, db);

    if (res === null) {
      throw new Error("Recipe not found");
    }
  }
};
