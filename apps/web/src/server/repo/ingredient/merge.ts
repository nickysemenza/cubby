/**
 * Ingredient merge: near-duplicate candidate detection (trigram self-join) and
 * the merge operation that folds aliases + re-points usages/products onto a
 * surviving target before hard-deleting the absorbed rows.
 */

import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  type IngredientId,
  unsafeIngredientId,
} from "@cubby/schemas/identifiers";
import type { MergeSummaryOut } from "@cubby/schemas/ingredient";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  ingredient,
  product,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

export const INGREDIENT_MERGE_EDGE_POLICY = {
  "RecipeSectionIngredient.ingredientId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "A merged ingredient's recipe lines are re-pointed onto the surviving ingredient.",
  },
  "Product.ingredientId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "A merged ingredient's linked products are re-pointed onto the surviving ingredient.",
  },
} as const satisfies IncomingEdgePolicy<"ingredient", OperationDisposition>;

/**
 * The serialized {@link MergeSummaryOut} (aliasesAdded / recipesMoved /
 * productsMoved / deletedIds) plus the internal `affectedRecipeIds` the caller
 * marks stale + dispatches for recompute (never serialized — superset of the
 * moved set, see the read in `resolve`).
 */
export type MergeSummary = MergeSummaryOut & { affectedRecipeIds: RecipeId[] };

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

/**
 * Distinct recipe ids that use any of the given ingredients (via any section).
 * Read with the same `tx`/db client the caller is on so a dry-run and the
 * transactional path share one query shape.
 */
const recipeIdsUsingIngredients = async (
  conn: Pick<ReturnType<typeof getDb>, "selectDistinct">,
  ingredientIds: IngredientId[],
): Promise<RecipeId[]> => {
  if (ingredientIds.length === 0) return [];
  const rows = await conn
    .selectDistinct({ recipeId: recipeSection.recipeId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .where(inArray(recipeSectionIngredient.ingredientId, ingredientIds));
  return rows.map((r) => r.recipeId);
};

/**
 * Merge `aliases` into `target`: fold their names/aliases into the target, then
 * re-point their recipe lines + products onto it before hard-deleting them. The
 * absorbed recipes' totals are marked stale (`totalsComputedAt = null`)
 * **inside the transaction** so they are never silently wrong; the caller
 * dispatches the (potentially heavy) recompute off the request path.
 *
 * Fails loudly — and writes nothing — when:
 * - `target` is itself in `aliases` (self-merge would delete the survivor), or
 * - any alias id doesn't resolve to a live ingredient (the old code silently
 *   no-op'd on a typo'd/deleted id, returning "success" while changing nothing).
 *
 * `dryRun` runs the same validation and counts what *would* change without
 * writing — the safe preview for a dedup sweep.
 */
export const mergeIngredients = async (
  db: Database,
  target: IngredientId,
  aliases: IngredientId[],
  opts?: { dryRun?: boolean },
): Promise<MergeSummary> => {
  const uniqueAliases = uniq(aliases);
  if (uniqueAliases.includes(target)) {
    throw createAppError(
      "INGREDIENT_MERGE_INVALID",
      `Cannot merge ingredient ${target} into itself`,
    );
  }

  // Validate + resolve against the given client; returns the survivor + the
  // freshly-computed alias set + the absorbed recipes. Shared by both paths so
  // the dry-run and the real merge can't diverge on what counts as valid.
  const resolve = async (
    conn: ReturnType<typeof getDb>,
  ): Promise<{
    newAliases: string[];
    aliasesAdded: string[];
    deletedIds: IngredientId[];
    /** Recipes whose lines move off an alias onto the target (the summary count). */
    movedRecipeIds: RecipeId[];
    /**
     * Every recipe whose totals can change — alias-using AND already-target-using
     * (moving the aliases' products onto the target shifts the target's cost). The
     * recompute / stale-marking set; superset of movedRecipeIds.
     */
    affectedRecipeIds: RecipeId[];
    productsMoved: number;
  }> => {
    const targetRec = await conn.query.ingredient.findFirst({
      // notDeleted: a soft-deleted target would otherwise pass validation and
      // recipe lines would re-point onto a row hidden from every normal query.
      where: and(eq(ingredient.id, target), notDeleted(ingredient)),
    });
    if (!targetRec) {
      throw createAppError(
        "INGREDIENT_NOT_FOUND",
        `Target ingredient ${target} not found`,
      );
    }

    const aliasRecs = await conn.query.ingredient.findMany({
      where: and(inArray(ingredient.id, uniqueAliases), notDeleted(ingredient)),
    });
    // Fail loud on a no-op: any id that didn't resolve to a live ingredient is a
    // typo or already-deleted row, NOT a silent success.
    if (aliasRecs.length !== uniqueAliases.length) {
      const found = new Set(aliasRecs.map((a) => a.id));
      const missing = uniqueAliases.filter((id) => !found.has(id));
      throw createAppError(
        "INGREDIENT_NOT_FOUND",
        `Alias ingredient(s) not found or already deleted: ${missing.join(", ")}`,
      );
    }

    const newAliases = uniq([
      ...targetRec.aliases,
      ...aliasRecs.map((a) => a.name),
      ...aliasRecs.flatMap((a) => a.aliases ?? []),
    ]);
    const existing = new Set(targetRec.aliases);
    // Read both sets BEFORE the re-point: lines using an alias are the ones that
    // move; recipes already using the target also need recompute because the
    // moved products change the target's cost. `[...aliases, target]` is exactly
    // the post-merge target-using set the old `recomputeForIngredient(target)`
    // covered.
    const movedRecipeIds = await recipeIdsUsingIngredients(conn, uniqueAliases);
    const affectedRecipeIds = await recipeIdsUsingIngredients(conn, [
      ...uniqueAliases,
      target,
    ]);
    const movedProducts = await conn
      .select({ id: product.id })
      .from(product)
      .where(inArray(product.ingredientId, uniqueAliases));

    return {
      newAliases,
      aliasesAdded: newAliases.filter((a) => !existing.has(a)),
      deletedIds: aliasRecs.map((a) => a.id),
      movedRecipeIds,
      affectedRecipeIds,
      productsMoved: movedProducts.length,
    };
  };

  if (opts?.dryRun) {
    const r = await resolve(getDb(db));
    return {
      aliasesAdded: r.aliasesAdded,
      recipesMoved: r.movedRecipeIds.length,
      productsMoved: r.productsMoved,
      deletedIds: r.deletedIds,
      affectedRecipeIds: r.affectedRecipeIds,
    };
  }

  return await withTransaction(db, async (tx) => {
    const r = await resolve(tx);

    // fold the absorbed names/aliases into the survivor
    await tx
      .update(ingredient)
      .set({ aliases: r.newAliases })
      .where(eq(ingredient.id, target));

    // re-point every recipe line onto the target
    await tx
      .update(recipeSectionIngredient)
      .set({ ingredientId: target })
      .where(inArray(recipeSectionIngredient.ingredientId, uniqueAliases));

    // Re-point any products linked to the alias ingredients onto the target.
    // Otherwise the FK from Product.ingredientId blocks the hard delete below
    // (this is the whole point of merging: the surviving ingredient inherits the
    // others' products — e.g. "share this USDA food / price"). Covers
    // soft-deleted products too, since the FK applies to every row.
    await tx
      .update(product)
      .set({ ingredientId: target })
      .where(inArray(product.ingredientId, uniqueAliases));

    // delete the absorbed ingredients
    await tx.delete(ingredient).where(inArray(ingredient.id, uniqueAliases));

    // Correctness floor: flag the absorbed recipes stale atomically with the
    // merge, so they read as pending — countable on Settings → Maintenance
    // (countStaleRecipeTotals) and healable by recompute-all — even if the
    // dispatched recompute never lands.
    if (r.affectedRecipeIds.length > 0) {
      await tx
        .update(recipe)
        .set({ totalsComputedAt: null })
        .where(inArray(recipe.id, r.affectedRecipeIds));
    }

    return {
      aliasesAdded: r.aliasesAdded,
      recipesMoved: r.movedRecipeIds.length,
      productsMoved: r.productsMoved,
      deletedIds: r.deletedIds,
      affectedRecipeIds: r.affectedRecipeIds,
    };
  });
};
