/**
 * Recipe-centric Problems detectors.
 *
 * Guardrail for the derived-data-on-removal invariant: deleting a sub-recipe
 * must mark its parent recipes' persisted totals stale (see recipe.delete —
 * `dispatchRecompute(parentIds)`). This detector surfaces the ESCAPED state that
 * bug would leave behind: a live parent recipe that still references a
 * soft-deleted sub-recipe yet whose `totalsComputedAt` is non-null (so it reads
 * as fresh and `countStaleRecipeTotals` — which only counts `totalsComputedAt IS
 * NULL` — misses it). After the fix this set is always empty; a non-empty result
 * means a removal path skipped staleness propagation.
 */

import { unsafeRecipeShortcode } from "@cubby/schemas/identifiers";
import type {
  RecipeWithoutInstructions,
  StaleParentRecipe,
} from "@cubby/schemas/problems";
import { and, count, eq, notExists, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

// StaleParentRecipe is the canonical Zod-derived shape from @cubby/schemas/problems
// (re-exported from the package barrel for the Problems-page components).
export type { StaleParentRecipe };

/**
 * Live parent recipes whose persisted totals are marked fresh
 * (`totalsComputedAt IS NOT NULL`) but that still reference — via a live
 * section → link → sub-recipe ingredient — a soft-deleted sub-recipe. This is
 * pure SQL (no WASM) so it's safe on the Problems hot path. The
 * `totalsComputedAt IS NOT NULL` predicate deliberately excludes rows already
 * flagged stale, since those are the `countStaleRecipeTotals` domain.
 */
export const findParentRecipesWithDeletedSubRecipes = async (
  db: Database,
): Promise<StaleParentRecipe[]> => {
  const res = await getDb(db).execute<StaleParentRecipe>(sql`
    SELECT DISTINCT parent.shortcode AS id, parent.name AS name
    FROM ${recipe} parent
    INNER JOIN ${recipeSection} rs
      ON rs."recipeId" = parent.id AND rs."deletedAt" IS NULL
    INNER JOIN ${recipeSectionIngredient} rsi
      ON rsi."recipeSectionId" = rs.id AND rsi."deletedAt" IS NULL
    INNER JOIN ${ingredient} i
      ON i.id = rsi."ingredientId"
      AND i."deletedAt" IS NULL
      AND i."recipeId" IS NOT NULL
    INNER JOIN ${recipe} sub
      ON sub.id = i."recipeId"
    WHERE parent."deletedAt" IS NULL
      AND parent."totalsComputedAt" IS NOT NULL
      AND sub."deletedAt" IS NOT NULL
  `);
  return res.rows;
};

/**
 * Live recipes with no instruction text anywhere.
 *
 * Instructions are a jsonb array ON the section, not a child table, so "has no
 * instructions" is `jsonb_array_length(...) = 0` across every live section
 * rather than an absent row. The column is `NOT NULL DEFAULT '[]'`, so no
 * COALESCE is needed.
 *
 * Book- and Notion-sourced recipes are excluded rather than flagged: a cookbook
 * import legitimately has none, because the instructions are in the book. The
 * recipe-name trigram index in schema.ts excludes the same two sources for the
 * same reason. A NULL SourceType is a legacy hand-entered row and DOES count —
 * `IS DISTINCT FROM` keeps those in.
 *
 * Blank-string instruction entries (`{ text: "" }`) are deliberately not
 * chased: that needs a `jsonb_array_elements` scan per section, and this
 * detector rides the fast group, which is cheap-by-contract.
 */
export const findRecipesWithoutInstructions = async (
  db: Database,
): Promise<RecipeWithoutInstructions[]> => {
  const rows = await getDb(db)
    .select({
      shortcode: recipe.shortcode,
      name: recipe.name,
      sectionCount: count(recipeSection.id),
    })
    .from(recipe)
    .leftJoin(
      recipeSection,
      and(eq(recipeSection.recipeId, recipe.id), notDeleted(recipeSection)),
    )
    .where(
      and(
        notDeleted(recipe),
        sql`${recipe.SourceType} IS DISTINCT FROM 'Book'`,
        sql`${recipe.SourceType} IS DISTINCT FROM 'Notion'`,
        notExists(
          getDb(db)
            .select({ one: recipeSection.id })
            .from(recipeSection)
            .where(
              and(
                eq(recipeSection.recipeId, recipe.id),
                notDeleted(recipeSection),
                sql`jsonb_array_length(${recipeSection.instructions}) > 0`,
              ),
            ),
        ),
      ),
    )
    .groupBy(recipe.id, recipe.shortcode, recipe.name)
    .orderBy(sql`${recipe.name} asc`);

  return rows.map((row) => ({
    id: unsafeRecipeShortcode(row.shortcode),
    name: row.name,
    sectionCount: row.sectionCount,
  }));
};
