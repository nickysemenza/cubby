import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./fakeRecipes";
import { insertRecipeFromCompact } from "~/server/compactrecipe";
import { getRecipeByID } from "~/server/api/routers/recipe";
import { ItemType, type PrismaClient } from "@prisma/client";
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
    const res = await db.item.upsert({
      where: {
        name_type: { name: ingredient.name, type: ItemType.Ingredient },
      },
      create: { name: ingredient.name, type: ItemType.Ingredient },
      update: {
        parentItemId: null,
      },
    });

    for (const alias of ingredient.aliases ?? []) {
      await db.item.upsert({
        where: {
          name_type: { name: alias, type: ItemType.Ingredient },
        },
        create: { name: alias, type: ItemType.Ingredient },
        update: {
          parentItemId: res.id,
        },
      });
    }

    console.log(res);
  }
};
