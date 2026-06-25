import { and, isNull } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  image,
  ingredient,
  inventoryEntry,
  location,
  product,
  recipe,
} from "~/server/db/schema";
import { countWhere, notDeleted } from "~/server/repo/database-helpers";

export interface DashboardEntityCounts {
  products: number;
  recipes: number;
  ingredients: number;
  locations: number;
  inventory: number;
  images: number;
}

/**
 * The six DB-backed dashboard count-card totals, as cheap parallel `COUNT(*)`s —
 * NO list fetch and NO USDA enrichment (the count cards only display the number).
 * Each WHERE mirrors the corresponding `*List` repo's base filter for an empty
 * filter set so the totals match the list pages exactly:
 *   - ingredient also excludes recipe-pointer rows (`recipeId IS NULL`), like
 *     `ingredientList`.
 *   - image has no soft-delete column, so it counts every row (matching
 *     `imageList` with no filter).
 * Filtered counts are intentionally not supported here — the `*.list` procedures
 * still serve filtered/paginated views.
 */
export const getDashboardEntityCounts = async (
  db: Database,
): Promise<DashboardEntityCounts> => {
  const [products, recipes, ingredients, locations, inventory, images] =
    await Promise.all([
      countWhere(db, product, notDeleted(product)),
      countWhere(db, recipe, notDeleted(recipe)),
      countWhere(
        db,
        ingredient,
        and(isNull(ingredient.recipeId), notDeleted(ingredient)),
      ),
      countWhere(db, location, notDeleted(location)),
      countWhere(db, inventoryEntry, notDeleted(inventoryEntry)),
      countWhere(db, image),
    ]);

  return { products, recipes, ingredients, locations, inventory, images };
};
