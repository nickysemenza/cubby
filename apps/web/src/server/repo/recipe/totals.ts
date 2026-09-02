/**
 * Persistence + invalidation for precomputed recipe totals (cost/calories).
 * Totals live in the `Recipe.totals` jsonb; `totalsComputedAt IS NULL` marks a
 * row stale. Marking is event-driven (recipe/product writes); recompute is done
 * by the presence-driven drain. See recipe-costing.service.
 */

import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { TraceNames, withTrace } from "~/server/tracing";

// JSONB totals written before per-target nutrient coverage existed look fresh
// by timestamp alone, but cannot safely answer protein (or any macro) portion
// estimates. Keep the persisted data readable and let the normal stale drain
// upgrade it; no migration/backfill stamp is needed.
const totalsNeedNutrientCoverage = sql`(
  ${recipe.totals} ->> 'caloriesCovered' IS NULL OR
  ${recipe.totals} ->> 'proteinCovered' IS NULL OR
  ${recipe.totals} ->> 'fatCovered' IS NULL OR
  ${recipe.totals} ->> 'carbsCovered' IS NULL OR
  ${recipe.totals} ->> 'fiberCovered' IS NULL OR
  ${recipe.totals} ->> 'sodiumCovered' IS NULL
)`;
const recipeTotalsAreStale = or(
  sql`${recipe.totalsComputedAt} IS NULL`,
  totalsNeedNutrientCoverage,
);

/**
 * Persist computed totals for one or many recipes in one raw `UPDATE ... FROM
 * (VALUES ...)`, stamping them fresh without touching `Recipe.updatedAt`.
 *
 * Avoid the Drizzle update builder here: the schema's `$onUpdate` hook adds
 * `updatedAt = now()` to every update, but recomputing derived totals is not a
 * user-visible recipe edit. The `VALUES` shape also binds each id once instead
 * of duplicating ids across a `CASE ... WHERE id IN (...)` statement.
 */
export const updateRecipeTotalsBatch = async (
  db: Database,
  entries: ReadonlyArray<{ id: RecipeId; totals: RecipeTotals }>,
): Promise<void> => {
  if (entries.length === 0) return;
  const computedAt = new Date();
  const values = sql.join(
    entries.map(
      (e) => sql`(${e.id}::uuid, ${JSON.stringify(e.totals)}::jsonb)`,
    ),
    sql`, `,
  );
  await getDb(db).execute(sql`
    UPDATE ${recipe}
    SET
      ${sql.identifier("totals")} = v.totals,
      ${sql.identifier("totalsComputedAt")} = ${computedAt}
    FROM (VALUES ${values}) AS v(id, totals)
    WHERE ${recipe.id} = v.id
  `);
};

/**
 * Stamp recipes fresh without rewriting the `totals` jsonb payload. Used when a
 * recompute proves the persisted totals are already correct.
 */
export const markRecipeTotalsFresh = async (
  db: Database,
  ids: RecipeId[],
): Promise<void> => {
  if (ids.length === 0) return;
  await getDb(db).execute(sql`
    UPDATE ${recipe}
    SET ${sql.identifier("totalsComputedAt")} = ${new Date()}
    WHERE ${recipe.id} IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
};

/**
 * Flag recipes' totals stale (`totalsComputedAt = null`) without recomputing —
 * the correctness floor when the recompute is deferred to the queue: the rows
 * read as pending until the queue drains. If a wave is lost (DLQ), they stay
 * stale and are surfaced by `countStaleRecipeTotals` on Settings → Maintenance,
 * cleared by recompute-all. Unconditional on purpose: that's about the
 * fresh/stale predicate (no `AND totalsComputedAt IS NOT NULL` guard, unlike
 * the transitioned-only variant below), NOT about liveness — this is still the
 * durable "these are pending" stamp at dispatch (and at merge). The cascade
 * tail uses {@link markRecipesStaleReturningTransitioned} instead, to avoid
 * re-staling recipes a sibling chunk already queued. `notDeleted` is required:
 * every path that could later heal this stamp (`selectStaleRecipeIds`,
 * `selectAllStaleRecipeIds`, `countStaleRecipeTotals`, `getRecipesByIDs`)
 * filters to live recipes, so a soft-deleted recipe stamped stale here would
 * be nulled forever with nothing to clear it or report it.
 */
export const markRecipesStale = async (
  db: Database,
  ids: RecipeId[],
): Promise<void> => {
  if (ids.length === 0) return;
  await getDb(db).execute(sql`
    UPDATE ${recipe}
    SET ${sql.identifier("totalsComputedAt")} = NULL
    WHERE ${recipe.id} IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND ${notDeleted(recipe)}
  `);
};

/**
 * Stale recipes and return ONLY the ids that actually transitioned fresh→stale.
 * The `AND "totalsComputedAt" IS NOT NULL` predicate (+ `RETURNING id`) makes a
 * recipe that is already stale a no-op that yields nothing — so the parent
 * cascade enqueues a follow-up only on the edge, never re-sending a parent that
 * the initial dispatch set or a sibling chunk already staled+queued. Backed by
 * the partial index `Recipe_totals_stale_idx`. This is the fan-out-amplification
 * suppressor on the recursive tail — NOT a correctness floor (use
 * {@link markRecipesStale} for that): the only false-negative is a recipe left
 * stale by a prior lost wave, healed by recompute-all.
 */
export const markRecipesStaleReturningTransitioned = async (
  db: Database,
  ids: RecipeId[],
): Promise<RecipeId[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).execute<{ id: RecipeId }>(sql`
    UPDATE ${recipe}
    SET ${sql.identifier("totalsComputedAt")} = NULL
    WHERE ${recipe.id} IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND ${recipe.totalsComputedAt} IS NOT NULL
      AND ${notDeleted(recipe)}
    RETURNING ${recipe.id}
  `);
  return rows.rows.map((r) => r.id);
};

/** Count active recipes pending recompute, including legacy totals without coverage. */
export const countStaleRecipeTotals = async (db: Database): Promise<number> => {
  const [row] = await getDb(db)
    .select({ n: count() })
    .from(recipe)
    .where(and(recipeTotalsAreStale, notDeleted(recipe)));
  return row?.n ?? 0;
};

/**
 * Filter a queued message down to recipes that are still stale. Queue messages
 * are just wakeups: repeated product edits or parent cascades may enqueue ids
 * that another invocation has already recomputed.
 */
export const selectStaleRecipeIds = async (
  db: Database,
  ids: RecipeId[],
): Promise<RecipeId[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db)
    .select({ id: recipe.id })
    .from(recipe)
    .where(
      and(inArray(recipe.id, ids), recipeTotalsAreStale, notDeleted(recipe)),
    );
  return rows.map((r) => r.id);
};

/** Persisted totals state for one recipe (explain endpoint). Null = not found. */
export const getRecipeTotalsState = async (
  db: Database,
  id: RecipeId,
): Promise<{
  totals: RecipeTotals | null;
  totalsComputedAt: Date | null;
} | null> =>
  withTrace(TraceNames.db("recipe.getRecipeTotalsState"), async (span) => {
    span.setAttribute("db.table", "recipe");
    const [row] = await getDb(db)
      .select({
        totals: recipe.totals,
        totalsComputedAt: recipe.totalsComputedAt,
      })
      .from(recipe)
      .where(and(eq(recipe.id, id), notDeleted(recipe)))
      .limit(1);
    return row ?? null;
  });

/**
 * Raw `totalsComputedAt` for one recipe, live or soft-deleted. Every other
 * reader in this file requires `notDeleted` (that's the point of the liveness
 * guard on {@link markRecipesStale}), so there is otherwise no way to observe
 * whether a stamp reached a deleted row — this exists for that verification.
 * includes-deleted: diagnostic-only read, not a correctness-sensitive query.
 */
export const getRecipeTotalsStateIncludingDeleted = async (
  db: Database,
  id: RecipeId,
): Promise<{ totalsComputedAt: Date | null } | null> => {
  const [row] = await getDb(db)
    .select({ totalsComputedAt: recipe.totalsComputedAt })
    .from(recipe)
    .where(eq(recipe.id, id))
    .limit(1);
  return row ?? null;
};

/** All active recipe ids — for a full backfill/recompute. */
export const selectAllActiveRecipeIds = async (
  db: Database,
): Promise<RecipeId[]> =>
  withTrace(TraceNames.db("recipe.selectAllActiveRecipeIds"), async (span) => {
    span.setAttribute("db.table", "recipe");
    const rows = await getDb(db)
      .select({ id: recipe.id })
      .from(recipe)
      .where(notDeleted(recipe));
    span.setAttribute("db.result_count", rows.length);
    return rows.map((r) => r.id);
  });

/**
 * All active recipe ids whose totals are stale — the id-returning sibling of
 * {@link countStaleRecipeTotals} (same predicate: timestamp stale OR legacy
 * totals missing nutrient coverage, and not deleted). Used to seed a
 * stale-only recompute pass. Timestamp-stale rows use the partial index; the
 * one-time legacy JSONB upgrade may scan fresh timestamp rows.
 */
export const selectAllStaleRecipeIds = async (
  db: Database,
): Promise<RecipeId[]> => {
  const rows = await getDb(db)
    .select({ id: recipe.id })
    .from(recipe)
    .where(and(recipeTotalsAreStale, notDeleted(recipe)));
  return rows.map((r) => r.id);
};

/**
 * Recipes that reference ANY of the given ingredients (via any section), as a
 * flat deduped list. Used to invalidate when a product's price/USDA
 * link/ingredient changes (a product feeds recipe cost via its linked
 * ingredient). Batched so `recomputeForIngredients` does one `inArray`
 * round-trip instead of one query per ingredient; `selectDistinct` dedupes
 * recipe ids within the query.
 */
export const findRecipeIdsUsingIngredients = async (
  db: Database,
  ingredientIds: IngredientId[],
): Promise<RecipeId[]> => {
  if (ingredientIds.length === 0) return [];
  const rows = await getDb(db)
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
 * Parent recipes that use any of the given recipes as a sub-recipe (recipe-as-
 * ingredient is modelled as an ingredient row whose `recipeId` points at the
 * sub-recipe), returned as `subRecipeId → parentRecipeId[]`. The recompute
 * cascade calls this once per level instead of one query per recipe (the old N+1
 * that fanned out a DB round-trip per changed recipe). Sub-recipes with no parent
 * are absent from the map.
 *
 * Deliberately does NOT filter `deletedAt` on the section/link/ingredient joins
 * (unlike the sibling {@link recipeTreeLeafIngredientIds} and unlike
 * `findParentRecipesWithDeletedSubRecipes` in repo/problems/detectors-recipe.ts).
 * It must stay MORE inclusive than that detector — over-inclusion here is what
 * keeps the detector's "always empty after the fix" contract true instead of
 * merely reducing how often it fires. A phantom parent picked up through a
 * stale/soft-deleted link just recomputes to the same totals, since the actual
 * recompute reads only live sections. Tightening this filter is the risky
 * direction, not the safe one.
 */
export const findParentRecipeIdsBatch = async (
  db: Database,
  subRecipeIds: RecipeId[],
): Promise<Map<RecipeId, RecipeId[]>> => {
  const bySubRecipe = new Map<RecipeId, RecipeId[]>();
  if (subRecipeIds.length === 0) return bySubRecipe;
  const rows = await getDb(db)
    .selectDistinct({
      subRecipeId: ingredient.recipeId,
      parentRecipeId: recipeSection.recipeId,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .innerJoin(
      ingredient,
      eq(recipeSectionIngredient.ingredientId, ingredient.id),
    )
    .where(inArray(ingredient.recipeId, subRecipeIds));
  for (const r of rows) {
    if (r.subRecipeId == null) continue; // narrow the nullable FK
    const sub = r.subRecipeId;
    const parents = bySubRecipe.get(sub) ?? [];
    parents.push(r.parentRecipeId);
    bySubRecipe.set(sub, parents);
  }
  return bySubRecipe;
};

/**
 * Every leaf ingredient id reachable from a recipe's sub-recipe tree — the
 * recipe's own leaf ingredients plus those of every sub-recipe, transitively.
 *
 * A recipe includes another recipe by having an `Ingredient` row with `recipeId`
 * set (the sub-recipe link); a leaf ingredient has `recipeId IS NULL`. This walks
 * the closure of recipe ids in one recursive CTE (the `UNION` dedupes, which also
 * terminates any cycle), then collects the DISTINCT leaf ingredient ids referenced
 * anywhere in that closure. Used to scope the enrichment workbench to one recipe
 * (`?recipe=<id>`) without over-fetching full recipe graphs. Soft-deleted
 * sections / links / ingredients are excluded throughout.
 */
export const recipeTreeLeafIngredientIds = async (
  db: Database,
  recipeId: RecipeId,
): Promise<IngredientId[]> => {
  const res = await getDb(db).execute<{ id: IngredientId }>(sql`
    WITH RECURSIVE recipe_tree AS (
      SELECT ${recipeId}::uuid AS "recipeId"
      UNION
      SELECT i."recipeId"
      FROM recipe_tree rt
      INNER JOIN ${recipeSection} rs
        ON rs."recipeId" = rt."recipeId" AND rs."deletedAt" IS NULL
      INNER JOIN ${recipeSectionIngredient} rsi
        ON rsi."recipeSectionId" = rs.id AND rsi."deletedAt" IS NULL
      INNER JOIN ${ingredient} i
        ON i.id = rsi."ingredientId" AND i."deletedAt" IS NULL
      WHERE i."recipeId" IS NOT NULL
    )
    SELECT DISTINCT i.id
    FROM recipe_tree rt
    INNER JOIN ${recipeSection} rs
      ON rs."recipeId" = rt."recipeId" AND rs."deletedAt" IS NULL
    INNER JOIN ${recipeSectionIngredient} rsi
      ON rsi."recipeSectionId" = rs.id AND rsi."deletedAt" IS NULL
    INNER JOIN ${ingredient} i
      ON i.id = rsi."ingredientId" AND i."deletedAt" IS NULL
    WHERE i."recipeId" IS NULL
  `);
  return res.rows.map((r) => r.id);
};
