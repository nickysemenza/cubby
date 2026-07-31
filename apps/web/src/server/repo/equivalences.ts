import {
  unsafeIngredientShortcode,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { HarvestRow } from "~/lib/harvest-equivalences";
import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Every recipe-ingredient occurrence carrying ≥2 parsed measures — the raw
 * material for harvesting unit equivalences. The parser stores a parenthetical
 * secondary measure as a second element in `amounts` (e.g. "1 bunch kale (about
 * 5 cups)" → `[{1 bunch}, {5 cup}]`), so this is the only place those pairs live.
 *
 * Recipe-link ingredients (recipe-as-ingredient, `ingredient.recipeId` set) are
 * excluded — their amounts are recipe yields, not measurements of a food. Pure
 * DB: dimension classification + pairing happen in `harvestEquivalences`. Branded
 * ids (`ingredient.id`, `recipe.id`) and `amounts` (`$type<Amount[]>`) come back
 * natively typed; shortcode columns are deliberately unbranded in the schema, so
 * they get their brand here at the repo boundary.
 */
export const getMultiMeasureRecipeIngredients = async (
  db: Database,
): Promise<HarvestRow[]> => {
  const rows = await getDb(db)
    .select({
      ingredientId: ingredient.id,
      ingredientShortcode: ingredient.shortcode,
      ingredientName: ingredient.name,
      recipeId: recipe.id,
      recipeShortcode: recipe.shortcode,
      recipeName: recipe.name,
      rawLine: recipeSectionIngredient.rawLine,
      amounts: recipeSectionIngredient.amounts,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .innerJoin(
      recipeSection,
      eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
    )
    .innerJoin(recipe, eq(recipe.id, recipeSection.recipeId))
    .where(
      and(
        notDeleted(recipeSectionIngredient),
        notDeleted(recipe),
        isNull(ingredient.recipeId),
        sql`jsonb_array_length(${recipeSectionIngredient.amounts}) >= 2`,
      ),
    );
  return rows.map((r) => ({
    ...r,
    ingredientShortcode: unsafeIngredientShortcode(r.ingredientShortcode),
    recipeShortcode: unsafeRecipeShortcode(r.recipeShortcode),
  }));
};
