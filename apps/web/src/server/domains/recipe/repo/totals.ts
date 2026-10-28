import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
/**
 * Persistence + invalidation for precomputed recipe cost and nutrition totals.
 * Totals live in the `Recipe.totals` jsonb; `totalsComputedAt IS NULL` marks a
 * row stale. Marking is event-driven (recipe/product writes); recompute is done
 * by the broad recipes Job. See recipe-costing.ts.
 */
import { toStoredTotals } from "@cubby/schemas/nutrition";
import type { StoredRecipeTotals } from "@cubby/schemas/recipe-shared";
import { and, count, eq, inArray, sql } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import {
  repositoryQueries as unwrapDb,
  repositoryTransaction as withTransaction,
  repositoryTransactionOn as withTransactionOn,
} from "~/server/db/repository-access.boundary";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/retained-tables";
import { recordChange } from "~/server/generic/changes/repo/change";
import { TraceNames, withTrace } from "~/server/observability/tracing";

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
): Promise<RecipeId[]> => {
  if (entries.length === 0) return [];
  const computedAt = new Date();
  const values = sql.join(
    entries.map(
      (e) =>
        sql`(${e.id}::uuid, ${JSON.stringify(toStoredTotals(e.totals))}::jsonb)`,
    ),
    sql`, `,
  );
  // Recalculation stamps advance even for equal totals; only value/readiness changes notify.
  const changed = await unwrapDb(db).execute<{
    id: RecipeId;
    changed: boolean;
  }>(sql`
    WITH input(id, totals) AS (VALUES ${values}), previous AS MATERIALIZED (
      SELECT ${recipe.id} AS id, ${recipe.totals} AS totals,
        ${recipe.totalsComputedAt} IS NULL AS stale
      FROM ${recipe} JOIN input ON ${recipe.id} = input.id
      FOR NO KEY UPDATE OF ${recipe}
    )
    UPDATE ${recipe}
    SET
      ${sql.identifier("totals")} = v.totals,
      ${sql.identifier("totalsComputedAt")} = ${computedAt}
    FROM input v, previous
    WHERE ${recipe.id} = v.id AND previous.id = v.id
    RETURNING "Recipe".id, (previous.totals IS DISTINCT FROM v.totals OR previous.stale) AS changed
  `);
  if (changed.rows.some((row) => row.changed))
    await recordChange(db, {
      kind: "projection",
      categories: ["recipe"],
    });
  return changed.rows.filter((row) => row.changed).map((row) => row.id);
};

/**
 * Stamp recipes fresh without rewriting the `totals` jsonb payload. Used when a
 * recompute proves the persisted totals are already correct.
 */
const markRecipeTotalsFresh = async (
  db: Database | DrizzleTransaction,
  ids: RecipeId[],
): Promise<RecipeId[]> => {
  if (ids.length === 0) return [];
  const changed = await unwrapDb(db).execute<{
    id: RecipeId;
    changed: boolean;
  }>(sql`
    WITH previous AS MATERIALIZED (
      SELECT ${recipe.id} AS id, ${recipe.totalsComputedAt} IS NULL AS stale
      FROM ${recipe}
      WHERE ${recipe.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      FOR NO KEY UPDATE OF ${recipe}
    )
    UPDATE ${recipe}
    SET ${sql.identifier("totalsComputedAt")} = ${new Date()}
    FROM previous
    WHERE ${recipe.id} = previous.id
    RETURNING "Recipe".id, previous.stale AS changed
  `);
  if (changed.rows.some((row) => row.changed))
    await recordChange(db, { kind: "projection", categories: ["recipe"] });
  return changed.rows.filter((row) => row.changed).map((row) => row.id);
};

/** Persist stale totals and refresh intent together, including standalone callers. */
export const markRecipesStale = async (
  db: Database | DrizzleTransaction,
  ids: RecipeId[],
): Promise<void> => {
  if (!ids.length) return;
  await withTransactionOn(db, async (tx) => {
    await unwrapDb(tx).execute(sql`UPDATE ${recipe} SET "totalsComputedAt"=NULL
      WHERE ${inArray(recipe.id, ids)} AND ${notDeleted(recipe)}`);
    // `totalsComputedAt` is the value's own output, which its trigger
    // ignores; mark the recompute explicitly (ADR 0021).
    await unwrapDb(tx).execute(
      sql`SELECT derived_mark('recipe.totals', ${`{${ids.join(",")}}`}::uuid[])`,
    );
    await recordChange(tx, { kind: "source", categories: ["recipe"] });
  });
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

/** Read stored staleness without scheduling or recomputing a recipe. */
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

/** Publish prepared totals; the derived drain's publication fences the transaction. */
export const commitRecipeTotals = async (
  db: Database,
  input: {
    updates: ReadonlyArray<{ id: RecipeId; totals: StoredRecipeTotals }>;
    freshOnlyIds: RecipeId[];
    validateInputs?: (tx: DrizzleTransaction) => Promise<void>;
  },
): Promise<RecipeId[]> => {
  return withTransaction(db, async (tx) => {
    await input.validateInputs?.(tx);
    const updated = await updateRecipeTotalsBatch(tx, input.updates);
    const fresh = await markRecipeTotalsFresh(tx, input.freshOnlyIds);
    // Timestamp-only recalculations must not keep cyclic dependencies dirty.
    return [...new Set([...updated, ...fresh])];
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
        ON rs."recipeId" = rt."recipeId" AND ${notDeleted("rs")}
      INNER JOIN ${recipeSectionIngredient} rsi
        ON rsi."recipeSectionId" = rs.id AND ${notDeleted("rsi")}
      INNER JOIN ${ingredient} i
        ON i.id = rsi."ingredientId" AND ${notDeleted("i")}
      WHERE i."recipeId" IS NOT NULL
    )
    SELECT DISTINCT i.id
    FROM recipe_tree rt
    INNER JOIN ${recipeSection} rs
      ON rs."recipeId" = rt."recipeId" AND ${notDeleted("rs")}
    INNER JOIN ${recipeSectionIngredient} rsi
      ON rsi."recipeSectionId" = rs.id AND ${notDeleted("rsi")}
    INNER JOIN ${ingredient} i
      ON i.id = rsi."ingredientId" AND ${notDeleted("i")}
    WHERE i."recipeId" IS NULL
  `);
  return res.rows.map((r) => r.id);
};
