import type { IngredientId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { recipeSourceRelations } from "~/server/db/helpers/relations";
import { recipeSectionIngredient } from "~/server/db/schema";
import { computeRecipeUsages } from "~/server/domains/recipe/repo/helpers";

export const getRecipeUsagesForIngredient = async (
  db: Database,
  ingredientId: IngredientId,
) => {
  const rows = await getDb(db).query.recipeSectionIngredient.findMany({
    where: and(
      eq(recipeSectionIngredient.ingredientId, ingredientId),
      notDeleted(recipeSectionIngredient),
    ),
    with: {
      recipeSection: {
        with: { recipe: { with: recipeSourceRelations } },
      },
    },
  });
  return computeRecipeUsages(rows);
};
