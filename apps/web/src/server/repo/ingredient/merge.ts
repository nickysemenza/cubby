/**
 * Ingredient merge: near-duplicate candidate detection (trigram self-join) and
 * the merge operation that folds aliases + re-points usages/products onto a
 * surviving target before hard-deleting the absorbed rows.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  MergeCandidate,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  type IngredientId,
  type IngredientShortcode,
  unsafeIngredientShortcode,
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
import {
  countByTarget,
  impact,
  present,
  sideEffect,
} from "~/server/repo/impact";
import { finalizeMerge, repointEdge } from "~/server/repo/merge";
import { mergeImpactForIngredients } from "./search";

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
  for (const r of res.rows as unknown as Row[]) {
    const key = unsafeIngredientShortcode(r.source_shortcode);
    const arr = out.get(key) ?? [];
    if (arr.length >= perRow) continue;
    arr.push({
      id: unsafeIngredientShortcode(r.cand_shortcode),
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
  actor: ActorContext,
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
      deletedIds: aliasRecs.map((a) => unsafeIngredientShortcode(a.shortcode)),
      deletedEntityIds: aliasRecs.map((a) => a.id),
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
      deletedEntityIds: r.deletedEntityIds,
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

    // Re-point every recipe line, and every product linked to an alias
    // ingredient, onto the target. The product repoint isn't optional: the FK
    // from Product.ingredientId would block the hard delete below (and this is
    // the whole point of merging — the surviving ingredient inherits the
    // others' products, e.g. "share this USDA food / price").
    //
    // `liveOnly: false` on both: the delete below is a HARD delete, and the FK
    // constraint applies to every row regardless of `deletedAt`, so a
    // soft-deleted product left pointing at an alias would abort the merge.
    await repointEdge(
      tx,
      "ingredient",
      "RecipeSectionIngredient.ingredientId",
      {
        from: uniqueAliases,
        to: target,
        liveOnly: false,
      },
    );
    await repointEdge(tx, "ingredient", "Product.ingredientId", {
      from: uniqueAliases,
      to: target,
      liveOnly: false,
    });

    // Delete the absorbed ingredients AND cascade their search embeddings, as
    // one call — see `finalizeMerge`'s doc for why those can't be separated.
    // This is the repo's one HARD-delete merge; the hard-deleted rows still get
    // SOFT-deleted embeddings, same as a collapsed inventory source row.
    await finalizeMerge(tx, {
      entity: "ingredient",
      table: ingredient,
      keepId: target,
      loserIds: uniqueAliases,
      removal: "hard",
      actor,
      survivorChanges: {
        mergedFrom: { from: null, to: uniqueAliases },
      },
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
      deletedIds: r.deletedIds,
      deletedEntityIds: r.deletedEntityIds,
      affectedRecipeIds: r.affectedRecipeIds,
    };
  });
};

/**
 * Every alias-string a merged-away ingredient would contribute to the
 * survivor's alias list: its own name plus its existing aliases, minus
 * whatever the survivor (`keepId`) already carries. Not an incoming edge (it
 * mutates the survivor's own row, not a dependent table), so it isn't in
 * `INGREDIENT_MERGE_EDGE_POLICY` — reported as its own `changes` item instead.
 *
 * Approximate in one respect `resolve()` above is not: this dedupes each
 * source against the survivor only, not against the OTHER merged-away
 * ingredients too (resolve() folds the whole set through one `uniq()`). Two
 * sources sharing an alias neither already has would double-count by one
 * here. Acceptable for an advisory preview; the real merge is still the
 * source of truth for what actually lands in the alias list.
 */
const foldedAliasCountsByTarget = async (
  dbClient: ReturnType<typeof getDb>,
  keepId: IngredientId,
  mergeIds: IngredientId[],
): Promise<Record<string, number>> => {
  const survivor = await dbClient.query.ingredient.findFirst({
    where: and(eq(ingredient.id, keepId), notDeleted(ingredient)),
    columns: { name: true, aliases: true },
  });
  const existing = new Set(
    [survivor?.name, ...(survivor?.aliases ?? [])]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase()),
  );

  const rows = await dbClient.query.ingredient.findMany({
    where: and(inArray(ingredient.id, mergeIds), notDeleted(ingredient)),
    columns: { id: true, name: true, aliases: true },
  });

  const out: Record<string, number> = {};
  for (const row of rows) {
    const contributed = uniq([row.name, ...row.aliases]).filter(
      (n) => !existing.has(n.toLowerCase()),
    );
    if (contributed.length > 0) out[row.id] = contributed.length;
  }
  return out;
};

/**
 * What `mergeIngredients(db, keepId, mergeIds)` would do, without doing it.
 *
 * Reads the SAME `INGREDIENT_MERGE_EDGE_POLICY` the mutation writes against
 * for its two repoint edges (recipe lines, linked products) — `countByTarget`
 * runs the identical `inArray` + live-row predicate the mutation's own
 * `update(...).where(inArray(column, uniqueAliases))` touches. The
 * affected-recipe recompute side effect reuses
 * `recipeIdsUsingIngredients`, the exact function `resolve()` calls to
 * compute `affectedRecipeIds` for the real merge, so the two can't disagree
 * about which recipes go stale.
 *
 * Merging never blocks (no `block` disposition in the policy), so `blockers`
 * is always empty.
 *
 * Advisory only. `mergeIngredients` still re-validates and recomputes
 * everything inside its own transaction.
 */
export const previewMergeIngredients = async (
  db: Database,
  { mergeIds, keepId }: { mergeIds: IngredientId[]; keepId: IngredientId },
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  if (mergeIds.length === 0) {
    return { blockers: [], changes: [], sideEffects: [] };
  }
  const dbClient = getDb(db);

  const changes = present([
    impact({
      disposition:
        INGREDIENT_MERGE_EDGE_POLICY["RecipeSectionIngredient.ingredientId"],
      edgeKey: "RecipeSectionIngredient.ingredientId",
      label: "recipe usages re-pointed",
      byTargetId: await countByTarget(
        dbClient,
        recipeSectionIngredient,
        recipeSectionIngredient.ingredientId,
        mergeIds,
      ),
    }),
    impact({
      disposition: INGREDIENT_MERGE_EDGE_POLICY["Product.ingredientId"],
      edgeKey: "Product.ingredientId",
      label: "products moved",
      byTargetId: await countByTarget(
        dbClient,
        product,
        product.ingredientId,
        mergeIds,
      ),
    }),
    impact({
      disposition: {
        code: "fold-aliases",
        effect: "move-dedupe",
        description:
          "The merged ingredients' names and aliases are folded into the survivor's alias list.",
      },
      label: "aliases folded",
      byTargetId: await foldedAliasCountsByTarget(dbClient, keepId, mergeIds),
    }),
  ]);

  const affectedRecipeIds = await recipeIdsUsingIngredients(dbClient, [
    ...mergeIds,
    keepId,
  ]);
  const sideEffects =
    affectedRecipeIds.length > 0
      ? [
          sideEffect({
            code: "recompute-affected-recipes",
            label: "recipes recomputed",
            description:
              "Recipes using the merged ingredients — or already using the survivor — have their totals marked stale and recomputed.",
            total: affectedRecipeIds.length,
          }),
        ]
      : [];

  return { blockers: [], changes, sideEffects };
};

/**
 * Weight tiers for {@link previewMergeIngredientCandidates}, encoding the same
 * priority `rankImpact` (`merge-confirmation.tsx`) sorts candidates by: a USDA
 * link beats any product-count difference, a product-count difference beats
 * any recipe-usage difference, which beats alias count. Each tier's
 * multiplier is far larger than any realistic count in the tier below it (a
 * personal pantry app's ingredient never carries anywhere near a thousand
 * products or recipe usages), so summing them into one integer preserves the
 * lexicographic order without shipping a multi-key comparator over the wire.
 */
const USDA_LINK_WEIGHT = 1_000_000_000;
const PRODUCT_COUNT_WEIGHT = 1_000_000;
const RECIPE_USAGE_WEIGHT = 1_000;

/**
 * Per-candidate ranking data for the merge picker, before a keeper is named —
 * the mode the merge dialog needs to DEFAULT the keeper (sort descending by
 * `weight`) and show what each row carries (`detail`).
 *
 * Wraps {@link mergeImpactForIngredients} (`./search`) rather than re-querying:
 * same counts, reshaped into `MergeCandidate`. Replaces that function's role as
 * the confirmation dialog's data source; `mergeImpactForIngredients` stays
 * exported for its existing caller until it migrates.
 */
export const previewMergeIngredientCandidates = async (
  db: Database,
  ids: IngredientId[],
): Promise<MergeCandidate[]> => {
  const impacts = await mergeImpactForIngredients(db, ids);
  return impacts.map((i) => ({
    id: i.id,
    name: i.name,
    weight:
      (i.hasUsdaLink ? USDA_LINK_WEIGHT : 0) +
      i.productCount * PRODUCT_COUNT_WEIGHT +
      i.recipeUsageCount * RECIPE_USAGE_WEIGHT +
      i.aliasCount,
    detail: [
      { label: "USDA link", count: i.hasUsdaLink ? 1 : 0 },
      { label: "products", count: i.productCount },
      { label: "recipe usages", count: i.recipeUsageCount },
      { label: "aliases", count: i.aliasCount },
    ],
  }));
};
