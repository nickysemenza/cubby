import type { PartiallyImportedCookbook } from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { cookbook, recipe } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Live cookbooks with more extracted source recipes than live linked recipes.
 * `sourceRecipeCount` is stored at upsert (the recipe items in the extracted
 * book tree), so this never walks the JSON.
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
      ${cookbook.sourceRecipeCount}::int AS "sourceRecipeCount",
      count(${recipe.id})::int AS "recipeCount",
      (${cookbook.sourceRecipeCount} - count(${recipe.id}))::int AS "missingRecipeCount"
    FROM ${cookbook}
    LEFT JOIN ${recipe}
      ON ${recipe.cookbookId} = ${cookbook.id}
      AND ${recipe.deletedAt} IS NULL
    WHERE ${cookbook.deletedAt} IS NULL
    GROUP BY ${cookbook.id}
    HAVING ${cookbook.sourceRecipeCount} > count(${recipe.id})
    ORDER BY ${cookbook.name}
  `);
  return result.rows;
};
