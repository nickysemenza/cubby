/**
 * Cookbook-centric Problems detectors.
 *
 * A cookbook retains its complete extracted source in `rawJson`, while recipes
 * are imported selectively. This surfaces books whose live imported relation
 * has fallen below that retained source count; deleted recipes deliberately do
 * not count as imported.
 */

import type { PartiallyImportedCookbook } from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { cookbook, recipe } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Live cookbooks with more extracted source recipes than live linked recipes.
 *
 * The left join makes a never-imported cookbook visible. Keeping the recipe
 * liveness predicate in the join (rather than WHERE) preserves that zero-row
 * case and makes a soft-deleted recipe count as missing.
 */
export const findPartiallyImportedCookbooks = async (
  db: Database,
): Promise<PartiallyImportedCookbook[]> => {
  const result = await getDb(db).execute<PartiallyImportedCookbook>(sql`
    SELECT
      ${cookbook.shortcode} AS id,
      ${cookbook.name} AS name,
      coalesce(jsonb_array_length(${cookbook.rawJson}), 0)::int AS "sourceRecipeCount",
      count(${recipe.id})::int AS "recipeCount",
      (coalesce(jsonb_array_length(${cookbook.rawJson}), 0) - count(${recipe.id}))::int AS "missingRecipeCount"
    FROM ${cookbook}
    LEFT JOIN ${recipe}
      ON ${recipe.cookbookId} = ${cookbook.id}
      AND ${recipe.deletedAt} IS NULL
    WHERE ${cookbook.deletedAt} IS NULL
    GROUP BY ${cookbook.id}
    HAVING coalesce(jsonb_array_length(${cookbook.rawJson}), 0) > count(${recipe.id})
    ORDER BY ${cookbook.name}
  `);
  return result.rows;
};
