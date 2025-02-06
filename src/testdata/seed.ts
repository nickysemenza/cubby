import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./fakeRecipes";
import { insertRecipeFromCompact } from "~/server/compactrecipe";
import { getRecipeByID } from "~/server/api/routers/recipe";
import { type PrismaClient } from "@prisma/client";
import { exampleIngredients } from "./ingredients";

export const seedRealRecipes = async (db: PrismaClient) => {
  for (const recipe of exampleRecipesCompact) {
    const parsed = parseCompactRecipe(recipe);
    console.log(parsed);
    const recipeOut = await insertRecipeFromCompact(parsed, db);
    const res = await getRecipeByID(recipeOut.id, db);

    if (res === null) {
      throw new Error("Recipe not found");
    }
  }

  for (const ingredient of exampleIngredients) {
    const res = await db.ingredient.upsert({
      where: {
        name: ingredient.name,
      },
      create: {
        name: ingredient.name,
        aliases: ingredient.aliases ?? undefined,
      },
      update: {
        aliases: ingredient.aliases ?? undefined,
      },
    });

    console.log(res);
  }
};
