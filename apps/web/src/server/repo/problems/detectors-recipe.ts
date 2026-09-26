/**
 * Recipe-centric Problems detectors.
 *
 * Only the stale-parent guardrail lives here now — the missing-instructions
 * worklist became the `recipe/no-instructions` saved view once the list gained
 * an instructions-presence filter and a source axis.
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

import { ProblemItem } from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

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
): Promise<ProblemItem<"staleParentRecipes">[]> => {
  const res = await getDb(db).execute<ProblemItem<"staleParentRecipes">>(sql`
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
