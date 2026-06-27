/**
 * Persistence + invalidation for precomputed recipe totals (cost/calories).
 * Totals live in the `Recipe.totals` jsonb; `totalsComputedAt IS NULL` marks a
 * row stale. Marking is event-driven (recipe/product writes); recompute is done
 * by the presence-driven drain. See recipe-costing.service.
 */

import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe-shared";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { TraceNames, withTrace } from "~/server/tracing";

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
 * cleared by recompute-all. Unconditional on purpose: this is the durable
 * "these are pending" stamp at dispatch (and at merge). The cascade tail uses
 * {@link markRecipesStaleReturningTransitioned} instead, to avoid re-staling
 * recipes a sibling chunk already queued.
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
    RETURNING ${recipe.id}
  `);
  return rows.rows.map((r) => r.id);
};

/** Count of active recipes whose persisted totals are stale (pending recompute). */
export const countStaleRecipeTotals = async (db: Database): Promise<number> => {
  const [row] = await getDb(db)
    .select({ n: count() })
    .from(recipe)
    .where(and(sql`${recipe.totalsComputedAt} IS NULL`, notDeleted(recipe)));
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
      and(
        inArray(recipe.id, ids),
        sql`${recipe.totalsComputedAt} IS NULL`,
        notDeleted(recipe),
      ),
    );
  return rows.map((r) => r.id as RecipeId);
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
    return rows.map((r) => r.id as RecipeId);
  });

/**
 * Recipes that reference an ingredient (via any section). Used to invalidate when
 * a product's price/USDA link/ingredient changes (a product feeds recipe cost via
 * its linked ingredient).
 */
export const findRecipeIdsUsingIngredient = async (
  db: Database,
  ingredientId: IngredientId,
): Promise<RecipeId[]> => {
  const rows = await getDb(db)
    .selectDistinct({ recipeId: recipeSection.recipeId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .where(eq(recipeSectionIngredient.ingredientId, ingredientId));
  return rows.map((r) => r.recipeId);
};

/**
 * Parent recipes that use any of the given recipes as a sub-recipe (recipe-as-
 * ingredient is modelled as an ingredient row whose `recipeId` points at the
 * sub-recipe), returned as `subRecipeId → parentRecipeId[]`. The recompute
 * cascade calls this once per level instead of one query per recipe (the old N+1
 * that fanned out a DB round-trip per changed recipe). Sub-recipes with no parent
 * are absent from the map.
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
    const sub = r.subRecipeId as RecipeId;
    const parents = bySubRecipe.get(sub) ?? [];
    parents.push(r.parentRecipeId as RecipeId);
    bySubRecipe.set(sub, parents);
  }
  return bySubRecipe;
};
