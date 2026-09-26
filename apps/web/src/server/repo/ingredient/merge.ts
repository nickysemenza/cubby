/**
 * Ingredient merge: near-duplicate candidate detection (trigram self-join) and
 * the merge operation that folds aliases + re-points usages/products onto a
 * surviving target before hard-deleting the absorbed rows.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  type IngredientId,
  type IngredientShortcode,
  parseShortcodeFor,
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
import { finalizeMerge, resolveMergeTargets } from "~/server/repo/merge";
import { applyMergePolicy } from "~/server/repo/removal";

type IngredientSurvivorChanges = {
  mergedFrom: { from: null; to: string[] };
};

export const INGREDIENT_MERGE_EDGE_POLICY = {
  "MealFoodEntry.ingredientId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description:
      "Meal food entries retain their entered amounts while moving to the surviving ingredient.",
  },
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
  "Plant.ingredientId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Plants linked to a merged ingredient move to the survivor.",
  },
} as const satisfies IncomingEdgePolicy<"ingredient", OperationDisposition>;

/**
 * The serialized {@link MergeSummaryOut} (aliasesAdded / recipesMoved /
 * productsMoved / deletedIds) plus the internal `affectedRecipeIds` the caller
 * marks stale + dispatches for recompute (never serialized — superset of the
 * moved set, see the read in `resolve`).
 */
export type MergeSummary = MergeSummaryOut & {
  affectedRecipeIds: RecipeId[];
  deletedEntityIds: IngredientId[];
};

interface FuzzyMergeCandidate {
  id: IngredientShortcode;
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
): Promise<Map<IngredientShortcode, FuzzyMergeCandidate[]>> => {
  type Row = {
    source_id: string;
    source_shortcode: string;
    cand_id: string;
    cand_shortcode: string;
    cand_name: string;
    sim: number;
    has_product: boolean;
  };
  const res = await getDb(db).execute<Row>(sql`
    SELECT s.id AS source_id, s.shortcode AS source_shortcode, c.id AS cand_id,
           c.shortcode AS cand_shortcode, c.name AS cand_name,
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
  const out = new Map<IngredientShortcode, FuzzyMergeCandidate[]>();
  for (const r of res.rows) {
    const key = parseShortcodeFor("ingredient", r.source_shortcode);
    const arr = out.get(key) ?? [];
    if (arr.length >= perRow) continue;
    arr.push({
      id: parseShortcodeFor("ingredient", r.cand_shortcode),
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
 * Merge `mergeIds` into `keepId`: fold their names/aliases into the survivor,
 * then re-point their recipe lines + products onto it before hard-deleting
 * them. The absorbed recipes' totals are marked stale
 * (`totalsComputedAt = null`) **inside the transaction** so they are never
 * silently wrong; the caller dispatches the (potentially heavy) recompute off
 * the request path.
 *
 * Takes the same `{keepId, mergeIds}` SHORTCODE pair as the other three merges
 * and resolves it through the shared {@link resolveMergeTargets}. It used to
 * take branded uuids resolved by its router, which made it the one merge whose
 * public contract a generic caller could not reuse.
 *
 * Fails loudly — and writes nothing — when:
 * - `keepId` is itself in `mergeIds` (`MERGE_SELF_REFERENCE`, raised by
 *   `resolveMergeTargets` — the same refusal every merge and every merge
 *   preview now makes), or
 * - any id doesn't resolve to a live ingredient (the old code silently no-op'd
 *   on a typo'd/deleted id, returning "success" while changing nothing).
 */
export const mergeIngredients = async (
  db: Database,
  input: { keepId: string; mergeIds: readonly string[] },
  actor: ActorContext,
): Promise<MergeSummary> => {
  const { keepId: target, loserIds: uniqueAliases } = await resolveMergeTargets(
    db,
    { entity: "ingredient", keepId: input.keepId, mergeIds: input.mergeIds },
  );

  // Validate + resolve against the given client; returns the survivor + the
  // freshly-computed alias set + the absorbed recipes. Shared by both paths so
  // the dry-run and the real merge can't diverge on what counts as valid.
  const resolve = async (
    conn: ReturnType<typeof getDb>,
  ): Promise<{
    newAliases: string[];
    aliasesAdded: string[];
    deletedIds: IngredientShortcode[];
    deletedEntityIds: IngredientId[];
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
      deletedIds: aliasRecs.map((a) =>
        parseShortcodeFor("ingredient", a.shortcode),
      ),
      deletedEntityIds: aliasRecs.map((a) => a.id),
      movedRecipeIds,
      affectedRecipeIds,
      productsMoved: movedProducts.length,
    };
  };

  return await withTransaction(db, async (tx) => {
    const r = await resolve(tx);

    // fold the absorbed names/aliases into the survivor
    await tx
      .update(ingredient)
      .set({
        aliases: r.newAliases,
      })
      .where(eq(ingredient.id, target));

    // Re-point every declared edge onto the target: each is a real FK that
    // would abort the HARD delete below, tombstones included.
    await applyMergePolicy(tx, {
      entity: "ingredient",
      policy: INGREDIENT_MERGE_EDGE_POLICY,
      keepId: target,
      loserIds: uniqueAliases,
      liveOnly: false,
    });

    // Delete the absorbed ingredients AND cascade their search embeddings, as
    // one call — see `finalizeMerge`'s doc for why those can't be separated.
    // This is the repo's one HARD-delete merge; the hard-deleted rows still get
    // SOFT-deleted embeddings, same as a collapsed inventory source row.
    const survivorChanges: IngredientSurvivorChanges = {
      mergedFrom: { from: null, to: uniqueAliases },
    };
    const { removed } = await finalizeMerge(tx, {
      entity: "ingredient",
      table: ingredient,
      keepId: target,
      loserIds: uniqueAliases,
      removal: "hard",
      actor,
      survivorChanges,
    });

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
      merged: removed,
      deletedIds: r.deletedIds,
      deletedEntityIds: r.deletedEntityIds,
      affectedRecipeIds: r.affectedRecipeIds,
    };
  });
};
