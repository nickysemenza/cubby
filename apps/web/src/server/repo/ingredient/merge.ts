/**
 * Ingredient merge: near-duplicate candidate detection (trigram self-join) and
 * the merge operation that folds aliases + re-points usages/products onto a
 * surviving target before hard-deleting the absorbed rows.
 */

import {
  type IngredientId,
  unsafeIngredientId,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import {
  ingredient,
  product,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

interface FuzzyMergeCandidate {
  id: IngredientId;
  name: string;
  similarity: number;
}

/**
 * Trigram (pg_trgm) near-duplicate candidates, keyed by source ingredient — the
 * workbench's inline merge hint. A self-join of the standalone-ingredient table
 * surfaces, for each ingredient, the most similar OTHERS above `threshold`,
 * preferring ones that already have a product (merging inherits enrichment). The
 * caller looks up only the rows it shows. The table is small (~hundreds), so the
 * O(n²) similarity join is cheap and avoids fragile array-parameter binding.
 *
 * Suggestion-only: trigram has real false positives (e.g. "red wine vinegar" ~
 * "white wine vinegar", "firm-ripe pears" ~ "firm ripe peaches"), so the UI must
 * confirm before merging and never auto-apply.
 */
export const findFuzzyMergeCandidates = async (
  db: Database,
  { threshold = 0.5, perRow = 3 }: { threshold?: number; perRow?: number } = {},
): Promise<Map<IngredientId, FuzzyMergeCandidate[]>> => {
  type Row = {
    source_id: string;
    cand_id: string;
    cand_name: string;
    sim: number;
    has_product: boolean;
  };
  const res = await getDb(db).execute<Row>(sql`
    SELECT s.id AS source_id, c.id AS cand_id, c.name AS cand_name,
           similarity(s.name, c.name) AS sim,
           EXISTS (
             SELECT 1 FROM "Product" p
             WHERE p."ingredientId" = c.id AND p."deletedAt" IS NULL
           ) AS has_product
    FROM ${ingredient} s
    JOIN ${ingredient} c
      ON c."deletedAt" IS NULL AND c."recipeId" IS NULL AND c.id <> s.id
     AND similarity(s.name, c.name) > ${threshold}
    WHERE s."deletedAt" IS NULL AND s."recipeId" IS NULL
    ORDER BY s.id, has_product DESC, sim DESC
  `);

  // Already ordered best-first per source; keep the top `perRow` for each.
  const out = new Map<IngredientId, FuzzyMergeCandidate[]>();
  for (const r of res.rows as unknown as Row[]) {
    const key = unsafeIngredientId(r.source_id);
    const arr = out.get(key) ?? [];
    if (arr.length >= perRow) continue;
    arr.push({
      id: unsafeIngredientId(r.cand_id),
      name: r.cand_name,
      similarity: Number(r.sim),
    });
    out.set(key, arr);
  }
  return out;
};

export const mergeIngredients = async (
  db: Database,
  target: IngredientId,
  aliases: IngredientId[],
) => {
  return await withTransaction(db, async (tx) => {
    const targetRec = await tx.query.ingredient.findFirst({
      where: eq(ingredient.id, target),
    });

    if (!targetRec) {
      throw createAppError(
        "INGREDIENT_NOT_FOUND",
        `Target ingredient ${target} not found`,
      );
    }

    const aliasRecs = await tx.query.ingredient.findMany({
      where: and(inArray(ingredient.id, aliases), notDeleted(ingredient)),
    });

    // update target ingredient to have new aliases
    await tx
      .update(ingredient)
      .set({
        aliases: uniq([
          ...targetRec.aliases,
          ...aliasRecs.map((a) => a.name),
          ...aliasRecs.flatMap((a) => a.aliases ?? []),
        ]),
      })
      .where(eq(ingredient.id, target));

    // update all recipeSectionIngredients to point to the target
    await tx
      .update(recipeSectionIngredient)
      .set({
        ingredientId: target,
      })
      .where(inArray(recipeSectionIngredient.ingredientId, aliases));

    // Re-point any products linked to the alias ingredients onto the target.
    // Otherwise the FK from Product.ingredientId blocks the hard delete below
    // (this is the whole point of merging: the surviving ingredient inherits the
    // others' products — e.g. "share this USDA food / price"). Covers
    // soft-deleted products too, since the FK applies to every row.
    await tx
      .update(product)
      .set({ ingredientId: target })
      .where(inArray(product.ingredientId, aliases));

    // delete stale
    await tx.delete(ingredient).where(inArray(ingredient.id, aliases));
  });
};
