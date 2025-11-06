import { parseCompactRecipe } from "~/codec/parser";
import { exampleRecipesCompact } from "./fakeRecipes";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import { type Database } from "~/server/db";
import { getRecipeByID } from "~/server/repo/recipe";
import { unsafeRecipeId, type OrganizationId } from "~/schemas/identifiers";

export const seedRealRecipes = async (
  db: Database,
  organizationId: OrganizationId,
) => {
  for (const recipe of exampleRecipesCompact) {
    const parsed = await parseCompactRecipe(recipe);
    const recipeOut = await upsertRecipeFromCompact(parsed, db, organizationId);
    const res = await getRecipeByID(
      unsafeRecipeId(recipeOut.id),
      db,
      organizationId,
    );

    if (res === null) {
      throw new Error("Recipe not found");
    }
  }
};
