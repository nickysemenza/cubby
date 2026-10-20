/**
 * Persistence + invalidation for precomputed recipe cost and nutrition totals.
 * Totals live in the `Recipe.totals` jsonb; `totalsComputedAt IS NULL` marks a
 * row stale. Marking is event-driven (recipe/product writes); recompute is done
 * by the presence-driven drain. See recipe-costing.service.
 */

import { entitySchema } from "@cubby/schemas/entity";
import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import { toStoredTotals } from "@cubby/schemas/nutrition";
import type { StoredRecipeTotals } from "@cubby/schemas/recipe-shared";
import { createLogger } from "@cubby/worker-tracing";
import { and, count, eq, inArray, sql } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import {
  repositoryQueries as unwrapDb,
  repositoryTransaction as withTransaction,
} from "~/server/db/repository-access.boundary";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  derivedRefreshRevision,
  derivedRefreshPublication,
} from "~/server/db/retained-tables";
import { claimDerivedPublication } from "~/server/generic/derived-refresh/repo/publication";
import {
  currentInputRevision,
  DerivedInputsChanged,
} from "~/server/generic/derived-refresh/repo/revisions";
import { TraceNames, withTrace } from "~/server/observability/tracing";

const log = createLogger("recompute");

const recipeTotalsAreStale = sql`(${recipe.totalsComputedAt} IS NULL OR ${recipe.totals} IS NULL)`;

/**
 * Persist computed totals for one or many recipes in one raw `UPDATE ... FROM
 * (VALUES ...)`, stamping them fresh without touching `Recipe.updatedAt`.
 *
 * Avoid the Drizzle update builder here: the schema's `$onUpdate` hook adds
 * `updatedAt = now()` to every update, but recomputing derived totals is not a
 * user-visible recipe edit. The `VALUES` shape also binds each id once instead
 * of duplicating ids across a `CASE ... WHERE id IN (...)` statement.
 */
const updateRecipeTotalsBatch = async (
  db: Database | DrizzleTransaction,
  entries: ReadonlyArray<{ id: RecipeId; totals: StoredRecipeTotals }>,
): Promise<void> => {
  if (entries.length === 0) return;
  const computedAt = new Date();
  const values = sql.join(
    entries.map(
      (e) =>
        sql`(${e.id}::uuid, ${JSON.stringify(toStoredTotals(e.totals))}::jsonb)`,
    ),
    sql`, `,
  );
  await unwrapDb(db).execute(sql`
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
const markRecipeTotalsFresh = async (
  db: Database | DrizzleTransaction,
  ids: RecipeId[],
): Promise<void> => {
  if (ids.length === 0) return;
  await unwrapDb(db).execute(sql`
    UPDATE ${recipe}
    SET ${sql.identifier("totalsComputedAt")} = ${new Date()}
    WHERE ${recipe.id} IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
};

/**
 * Record pending totals for supplied live recipes. A delayed frontier cannot
 * invalidate a cache already published from the same or newer input revision.
 * The null stamp remains durable if the queue wake-up is lost.
 */
export const markRecipesStale = async (
  db: Database | DrizzleTransaction,
  ids: RecipeId[],
  inputRevision?: number,
): Promise<void> => {
  if (ids.length === 0) return;
  const revision = inputRevision ?? (await currentInputRevision(db));
  const invalidate = async (tx: DrizzleTransaction) => {
    // Both invalidation and computation lock this persistent row before Recipe.
    // Equal revisions already computed from these inputs must remain fresh.
    for (const id of [...ids].sort()) {
      await tx
        .insert(derivedRefreshPublication)
        .values({
          entityKind: "recipe",
          entityId: id,
          phase: "recipe-totals",
          revision: -1,
        })
        .onConflictDoNothing();
      await tx
        .select({ revision: derivedRefreshPublication.revision })
        .from(derivedRefreshPublication)
        .where(
          and(
            eq(derivedRefreshPublication.entityKind, "recipe"),
            eq(derivedRefreshPublication.entityId, id),
            eq(derivedRefreshPublication.phase, "recipe-totals"),
          ),
        )
        .for("update");
    }
    await tx.execute(sql`
    UPDATE ${recipe}
    SET ${sql.identifier("totalsComputedAt")} = NULL
    WHERE ${recipe.id} IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND ${notDeleted(recipe)}
      AND NOT EXISTS (SELECT 1 FROM ${derivedRefreshPublication} p
        WHERE p."entityKind"=${entitySchema.enum.recipe} AND p."entityId"=${recipe.id}
          AND p.phase='recipe-totals' AND p.revision >= ${revision})
  `);
  };
  if ("rollback" in db) await invalidate(db);
  else await withTransaction(db, invalidate);
};

/**
 * Stale recipes and return ONLY the ids that actually transitioned fresh→stale.
 * The `AND "totalsComputedAt" IS NOT NULL` predicate (+ `RETURNING id`) makes a
 * recipe that is already stale a no-op that yields nothing. The cascade uses
 * this inside its transaction so a duplicate wakeup never re-stales a parent
 * that is already fresh. Durable dependency pages separately propagate parents.
 */
const markRecipesStaleReturningTransitioned = async (
  db: Database | DrizzleTransaction,
  ids: RecipeId[],
): Promise<RecipeId[]> => {
  if (ids.length === 0) return [];
  const rows = await unwrapDb(db).execute<{ id: RecipeId }>(sql`
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

/** Count active recipes whose derived totals are missing or stale. */
export const countStaleRecipeTotals = async (
  db: Database | DrizzleTransaction,
): Promise<number> => {
  const [row] = await unwrapDb(db)
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
  db: Database | DrizzleTransaction,
  ids: RecipeId[],
): Promise<RecipeId[]> => {
  if (ids.length === 0) return [];
  const rows = await unwrapDb(db)
    .select({ id: recipe.id })
    .from(recipe)
    .where(
      and(inArray(recipe.id, ids), recipeTotalsAreStale, notDeleted(recipe)),
    );
  return rows.map((r) => r.id);
};

/** Persisted totals state for one recipe (explain endpoint). Null = not found. */
export const getRecipeTotalsState = async (
  db: Database | DrizzleTransaction,
  id: RecipeId,
): Promise<{
  totals: StoredRecipeTotals | null;
  totalsComputedAt: Date | null;
} | null> =>
  withTrace(TraceNames.db("recipe.getRecipeTotalsState"), async (span) => {
    span.setAttribute("db.table", "recipe");
    const [row] = await unwrapDb(db)
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
  db: Database | DrizzleTransaction,
): Promise<RecipeId[]> =>
  withTrace(TraceNames.db("recipe.selectAllActiveRecipeIds"), async (span) => {
    span.setAttribute("db.table", "recipe");
    const rows = await unwrapDb(db)
      .select({ id: recipe.id })
      .from(recipe)
      .where(notDeleted(recipe));
    span.setAttribute("db.result_count", rows.length);
    return rows.map((r) => r.id);
  });

/**
 * All active recipe ids whose totals are missing or stale — the id-returning
 * sibling of {@link countStaleRecipeTotals}. Used to seed a stale-only
 * recompute pass; timestamp-stale rows use the partial index.
 */
export const selectAllStaleRecipeIds = async (
  db: Database | DrizzleTransaction,
): Promise<RecipeId[]> => {
  const rows = await unwrapDb(db)
    .select({ id: recipe.id })
    .from(recipe)
    .where(and(recipeTotalsAreStale, notDeleted(recipe)));
  return rows.map((r) => r.id);
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
  db: Database | DrizzleTransaction,
  subRecipeIds: RecipeId[],
): Promise<Map<RecipeId, RecipeId[]>> => {
  const bySubRecipe = new Map<RecipeId, RecipeId[]>();
  if (subRecipeIds.length === 0) return bySubRecipe;
  const rows = await unwrapDb(db)
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
 * For each root, every recipe reachable from it through sub-recipe links —
 * transitively, and including the root itself when a cycle leads back to it.
 * The cascade uses this to refuse to stale a parent that is also a descendant
 * of the child that changed: around a cycle each recompute folds the other's
 * totals in again, so both keep "changing" and the cascade never converges
 * (inline it recursed without bound; queued it ping-ponged forever). The
 * Problems page's dependency-cycle detector is the durable report of such
 * data; the cascade only has to stop.
 */
const findSubRecipeDescendantIds = async (
  db: Database | DrizzleTransaction,
  rootIds: readonly RecipeId[],
): Promise<Map<RecipeId, Set<RecipeId>>> => {
  const byRoot = new Map<RecipeId, Set<RecipeId>>();
  if (rootIds.length === 0) return byRoot;
  const res = await unwrapDb(db).execute<{
    root: RecipeId;
    recipeId: RecipeId;
  }>(
    sql`
    WITH RECURSIVE recipe_tree AS (
      SELECT r.id AS root, r.id AS "recipeId", 0 AS depth
      FROM unnest(ARRAY[${sql.join(
        rootIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]) AS r(id)
      UNION
      SELECT rt.root, i."recipeId", 1
      FROM recipe_tree rt
      INNER JOIN ${recipeSection} rs
        ON rs."recipeId" = rt."recipeId" AND rs."deletedAt" IS NULL
      INNER JOIN ${recipeSectionIngredient} rsi
        ON rsi."recipeSectionId" = rs.id AND rsi."deletedAt" IS NULL
      INNER JOIN ${ingredient} i
        ON i.id = rsi."ingredientId" AND i."deletedAt" IS NULL
      WHERE i."recipeId" IS NOT NULL
    )
    SELECT DISTINCT root, "recipeId" FROM recipe_tree WHERE depth > 0
  `,
  );
  for (const row of res.rows) {
    const set = byRoot.get(row.root) ?? new Set<RecipeId>();
    set.add(row.recipeId);
    byRoot.set(row.root, set);
  }
  return byRoot;
};

/**
 * Commit one recompute chunk: changed totals, fresh stamps for unchanged
 * recipes, and the invalidation of every parent whose sub-recipe cost changed,
 * in ONE transaction. Publishing the parents' wakeups happens after commit —
 * so if publication fails the parents are already durably stale and any later
 * read, wakeup, or Maintenance Run recovers them.
 *
 * Returns the parents this commit staled (for an inline cascade to recurse
 * into) — only those that were fresh; a parent already stale from an earlier
 * wave is left alone rather than re-staled.
 */
export const commitRecipeTotals = async (
  db: Database,
  input: {
    updates: ReadonlyArray<{ id: RecipeId; totals: StoredRecipeTotals }>;
    freshOnlyIds: RecipeId[];
    changedIds: RecipeId[];
    /**
     * Every recipe this chunk just stamped. A parent recomputed in the same
     * chunk as its child was costed against the child's current lines and
     * must not be re-staled by the child's change.
     */
    processedIds: readonly RecipeId[];
    inputRevision?: number;
    /** Generic refresh already pages through parent recipes. */
    cascadeParents?: boolean;
  },
): Promise<{ changedParentIds: RecipeId[] }> => {
  return withTransaction(db, async (tx) => {
    const revision = input.inputRevision ?? (await currentInputRevision(tx));
    const accepted = new Set<RecipeId>();
    for (const id of [
      ...new Set([
        ...input.updates.map((entry) => entry.id),
        ...input.freshOnlyIds,
      ]),
    ].sort()) {
      if (
        await claimDerivedPublication(
          tx,
          { entityKind: "recipe", entityId: id },
          "recipe-totals",
          revision,
        )
      )
        accepted.add(id);
    }
    await updateRecipeTotalsBatch(
      tx,
      input.updates.filter((entry) => accepted.has(entry.id)),
    );
    await markRecipeTotalsFresh(
      tx,
      input.freshOnlyIds.filter((id) => accepted.has(id)),
    );
    const parentsByRecipe =
      input.cascadeParents === false
        ? new Map<RecipeId, RecipeId[]>()
        : await findParentRecipeIdsBatch(tx, input.changedIds);
    const descendants = await findSubRecipeDescendantIds(tx, [
      ...parentsByRecipe.keys(),
    ]);
    const processed = new Set<RecipeId>(input.processedIds);
    const changedParents = new Set<RecipeId>();
    const cyclic = new Set<RecipeId>();
    for (const [child, parents] of parentsByRecipe)
      for (const parent of parents) {
        if (processed.has(parent)) continue;
        if (descendants.get(child)?.has(parent)) cyclic.add(parent);
        else changedParents.add(parent);
      }
    if (cyclic.size > 0) {
      log.warn(
        `sub-recipe cycle: not re-staling ${cyclic.size} parent(s) that are also descendants`,
        { cyclic: [...cyclic] },
      );
    }
    await markRecipesStaleReturningTransitioned(tx, [...changedParents]);
    if (input.inputRevision !== undefined) {
      if (input.inputRevision === 0)
        await tx
          .insert(derivedRefreshRevision)
          .values({ key: "all", revision: 0 })
          .onConflictDoNothing();
      const stable = await tx
        .update(derivedRefreshRevision)
        .set({ revision: sql`${derivedRefreshRevision.revision}` })
        .where(
          and(
            eq(derivedRefreshRevision.key, "all"),
            eq(derivedRefreshRevision.revision, input.inputRevision),
          ),
        )
        .returning({ key: derivedRefreshRevision.key });
      if (stable.length === 0)
        throw new DerivedInputsChanged(
          "Recipe inputs changed during recomputation; retry current inputs",
        );
    }
    return { changedParentIds: [...changedParents] };
  });
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
  db: Database | DrizzleTransaction,
  recipeId: RecipeId,
): Promise<IngredientId[]> => {
  const res = await unwrapDb(db).execute<{ id: IngredientId }>(sql`
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
