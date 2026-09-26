import { ProblemItem } from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { cookbook, recipe } from "~/server/db/schema";
import { gapCondition } from "~/server/repo/data-quality/sql";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Live cookbooks with more extracted source recipes than live linked recipes.
 * `sourceRecipeCount` is stored at upsert (the recipe items in the extracted
 * book tree), so this never walks the JSON.
 *
 * The left join makes a never-imported cookbook visible. Keeping the recipe
 * liveness predicate in the join (rather than WHERE) preserves that zero-row
 * case and makes a soft-deleted recipe count as missing.
 *
 * The HAVING predicate is `cookbook_import_incomplete`'s own `gapCondition`
 * (checks/cookbook.ts) rather than a second hand-derived comparison — one
 * statement of "more source recipes than live imported ones", shared with the
 * `dataGaps=cookbook_import_incomplete` filter on the cookbook list.
 */
export const findPartiallyImportedCookbooks = async (
  db: Database,
): Promise<ProblemItem<"partiallyImportedCookbooks">[]> => {
  const result = await getDb(db).execute<
    ProblemItem<"partiallyImportedCookbooks">
  >(sql`
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
    HAVING ${gapCondition("cookbook", "cookbook_import_incomplete")}
    ORDER BY ${cookbook.name}
  `);
  return result.rows;
};
