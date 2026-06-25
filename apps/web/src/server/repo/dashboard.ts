import { and, isNull, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "~/server/db";
import {
  image,
  ingredient,
  inventoryEntry,
  location,
  product,
  recipe,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

// A `type` (not `interface`) so it satisfies the `Record<string, unknown>`
// constraint on `db.execute<T>()` below — interfaces don't get the implicit
// index signature that type-literal aliases do.
type DashboardEntityCounts = {
  products: number;
  recipes: number;
  ingredients: number;
  locations: number;
  inventory: number;
  images: number;
};

/**
 * The six DB-backed dashboard count-card totals, as cheap parallel `COUNT(*)`s —
 * NO list fetch and NO USDA enrichment (the count cards only display the number).
 * Each WHERE mirrors the corresponding `*List` repo's base filter for an empty
 * filter set so the totals match the list pages exactly:
 *   - ingredient also excludes recipe-pointer rows (`recipeId IS NULL`), like
 *     `ingredientList`.
 *   - image is hard-deleted in practice (repo/image.ts does a row DELETE, not a
 *     soft-delete), so `deletedAt` is never set and `notDeleted(image)` returns
 *     the same rows `imageList` counts — kept for the soft-delete convention.
 * Filtered counts are intentionally not supported here — the `*.list` procedures
 * still serve filtered/paginated views.
 */
export const getDashboardEntityCounts = async (
  db: Database,
): Promise<DashboardEntityCounts> => {
  // One round-trip, six scalar `COUNT(*)` subqueries — instead of six parallel
  // queries that also overran the per-request pool (max 5). `::int` keeps the
  // bigint count a JS number; the WHEREs reuse the same condition builders as
  // the `*List` repos so the totals stay in lockstep.
  const countCol = (table: PgTable, where: SQL | undefined): SQL =>
    where
      ? sql`(SELECT count(*)::int FROM ${table} WHERE ${where})`
      : sql`(SELECT count(*)::int FROM ${table})`;

  const res = await getDb(db).execute<DashboardEntityCounts>(sql`
    SELECT
      ${countCol(product, notDeleted(product))} AS products,
      ${countCol(recipe, notDeleted(recipe))} AS recipes,
      ${countCol(ingredient, and(isNull(ingredient.recipeId), notDeleted(ingredient)))} AS ingredients,
      ${countCol(location, notDeleted(location))} AS locations,
      ${countCol(inventoryEntry, notDeleted(inventoryEntry))} AS inventory,
      ${countCol(image, notDeleted(image))} AS images
  `);

  const row = res.rows[0];
  return {
    products: row?.products ?? 0,
    recipes: row?.recipes ?? 0,
    ingredients: row?.ingredients ?? 0,
    locations: row?.locations ?? 0,
    inventory: row?.inventory ?? 0,
    images: row?.images ?? 0,
  };
};
