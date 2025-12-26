import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./fakeRecipes";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import type { Database } from "~/server/db";
import { getRecipeByID } from "~/server/repo/recipe";
import { unsafeRecipeId } from "~/schemas/identifiers";
import type { ActorContext } from "~/schemas/context";

export const seedRealRecipes = async (db: Database, actor: ActorContext) => {
  for (const recipe of exampleRecipesCompact) {
    const parsed = await parseCompactRecipe(recipe);
    const recipeOut = await upsertRecipeFromCompact(parsed, db, actor);
    const res = await getRecipeByID(
      db,
      unsafeRecipeId(recipeOut.id),
      actor.organizationId,
    );

    if (res === null) {
      throw new Error("Recipe not found");
    }
  }
};
