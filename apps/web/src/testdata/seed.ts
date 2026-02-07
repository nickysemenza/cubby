import type { ActorContext } from "@cubby/schemas/context";
import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import { parseCompactRecipe } from "~/codec/parser";
import type { Database } from "~/server/db";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import { getRecipeByID } from "~/server/repo/recipe";
import { exampleRecipesCompact } from "./fakeRecipes";

export const seedRealRecipes = async (db: Database, actor: ActorContext) => {
  for (const recipe of exampleRecipesCompact) {
    const parsed = parseCompactRecipe(recipe);
    const recipeOut = await upsertRecipeFromCompact(parsed, db, actor);
    const res = await getRecipeByID(db, unsafeRecipeId(recipeOut.id));

    if (res === null) {
      throw new Error("Recipe not found");
    }
  }
};
