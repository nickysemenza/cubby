import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import type { MealId, MealRecipeId } from "@cubby/schemas/identifiers";
import type {
  MealCreateInput,
  MealFilters,
  MealOut,
  MealRecipeInput,
} from "@cubby/schemas/meal";
import { mealSortableFields } from "@cubby/schemas/meal";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { meal, mealRecipe } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  buildOrderBy,
  countWhere,
  executeListQueryWithCount,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  updateAndReturn,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { relatedWhereConditions } from "~/server/repo/related-view";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { dbMealToAPI } from "./helpers";

type MealMutationResult = { output: MealOut; entityId: MealId };

export const MEAL_DELETE_EDGE_POLICY = {
  "MealRecipe.mealId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Deleting a meal soft-deletes its planned recipes; the recipes themselves are untouched.",
  },
} as const satisfies IncomingEdgePolicy<"meal", OperationDisposition>;

const fetchMealById = async (db: Database, id: MealId) => {
  const row = await getDb(db).query.meal.findFirst({
    where: and(eq(meal.id, id), notDeleted(meal)),
    ...relations.meal.full,
  });
  return row;
};

// Read path through the shared reader. The write path stays hand-rolled: meal
// create/update/delete manage mealRecipe children inside a transaction.
const mealReader = createEntityReader({
  entity: "meal",
  fetchById: fetchMealById,
  fromDB: (_db, row) => dbMealToAPI(row),
});

export const getMealByID = (
  db: Database,
  id: MealId,
): Promise<MealOut | null> => mealReader.getByIDOrNull(db, id);

export const getMealByShortcode = (db: Database, shortcode: string) =>
  mealReader.getByShortcode(db, shortcode);

/** Throws MEAL_NOT_FOUND if the meal is missing — for callers that need a value. */
const requireMeal = (db: Database, id: MealId): Promise<MealOut> =>
  mealReader.getByID(db, id);

/** Meals whose date falls within [from, to] (inclusive) — the calendar query. */
// Bounds are "YYYY-MM-DD" strings compared against the date column (ISO date
// strings sort chronologically), so the calendar query has no timezone shift.
export const getMealsByDateRange = async (
  db: Database,
  from: string,
  to: string,
): Promise<MealOut[]> => {
  const rows = await getDb(db).query.meal.findMany({
    where: and(gte(meal.date, from), lte(meal.date, to), notDeleted(meal)),
    orderBy: (m, { asc }) => [asc(m.date), asc(m.sortOrder), asc(m.createdAt)],
    ...relations.meal.full,
  });
  return rows.map(dbMealToAPI);
};

export const mealList = async (
  db: Database,
  filters: MealFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: MealOut[]; count: number }> => {
  const orderByArray = buildOrderBy(meal, sorts, [...mealSortableFields]);
  const { take, skip } = buildTakeSkip(pagination);

  const whereCondition = and(
    notDeleted(meal),
    ...auditDateWhereConditions(meal, filters),
    // `mealFilterFields` spreads `mealRelatedFilterFields` (the recipe trio) and
    // the manifest renders its control — omitting this is the #588 drift, where
    // the UI sends a filter the server silently ignores.
    ...relatedWhereConditions("meal", filters, meal.id),
    filters.from ? gte(meal.date, filters.from) : undefined,
    filters.to ? lte(meal.date, filters.to) : undefined,
  );

  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db).query.meal.findMany({
      where: whereCondition,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.meal.full,
    }),
    countWhere(db, meal, whereCondition),
  );

  return { data: rows.map(dbMealToAPI), count };
};

export const createMealWithEntityId = async (
  db: Database,
  data: MealCreateInput,
  actor: ActorContext,
): Promise<MealMutationResult> => {
  const id = await withTransaction(db, async (tx) => {
    const created = await insertWithShortcode(tx, "meal", {
      date: data.date,
      name: data.name ?? null,
      sortOrder: data.sortOrder ?? null,
    });
    if (data.recipes?.length) {
      // `resolveAllOrThrow` returns ids positionally, one per input code, so
      // `recipeIds[i]` pairs with `data.recipes[i]` — the documented zip case.
      const recipeIds = await resolveAllOrThrow(
        tx,
        "recipe",
        data.recipes.map((recipe) => recipe.recipeId),
      );
      await tx.insert(mealRecipe).values(
        data.recipes.map((r, i) => ({
          mealId: created.id,
          recipeId: recipeIds[i]!,
          scale: r.scale,
          sortOrder: r.sortOrder ?? null,
        })),
      );
    }
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await requireMeal(db, id), entityId: id };
};

export const createMeal = async (
  db: Database,
  data: MealCreateInput,
  actor: ActorContext,
): Promise<MealOut> => (await createMealWithEntityId(db, data, actor)).output;

export const updateMeal = async (
  db: Database,
  id: MealId,
  data: { date?: string; name?: string | null; sortOrder?: number | null },
  actor: ActorContext,
): Promise<MealOut> => {
  // Mutation + audit in one transaction so the change is never left unrecorded.
  await withTransaction(db, async (tx) => {
    await updateLiveAndReturn(
      tx,
      meal,
      {
        ...(data.date !== undefined ? { date: data.date } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      },
      id,
    );
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: id,
      action: "update",
    });
  });
  return requireMeal(db, id);
};

/**
 * Soft-delete meals and cascade-soft-delete their planned recipes, all in one
 * transaction. Mirrors how other entity deletes cascade to their children.
 */
export const deleteMeals = async (
  db: Database,
  ids: MealId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, meal, ids, "Meal");
    const now = new Date();
    // notDeleted guard so rows already removed via removeMealRecipe keep their
    // original deletedAt instead of being stomped with `now`.
    await tx
      .update(mealRecipe)
      .set({ deletedAt: now })
      .where(and(inArray(mealRecipe.mealId, ids), notDeleted(mealRecipe)));
    await tx
      .update(meal)
      .set({ deletedAt: now })
      .where(and(inArray(meal.id, ids), notDeleted(meal)));
    // Removal-path invariant: meals are searchable/embedded, and the meal
    // manifest has onDelete: [], so this transaction is the only place their
    // EntityEmbedding rows get cleaned up.
    await softDeleteEntityEmbeddingsTx(tx, "meal", ids);
    await logAuditEntries(
      tx,
      actor,
      ids.map((id) => ({
        entityType: "meal" as const,
        entityId: id,
        action: "delete" as const,
      })),
    );
  });
};

export const addRecipeToMeal = async (
  db: Database,
  mealId: MealId,
  input: MealRecipeInput,
  actor: ActorContext,
): Promise<MealOut> => {
  await withTransaction(db, async (tx) => {
    const recipeId = await resolveOrThrow(tx, "recipe", input.recipeId);
    await insertAndReturn(tx, mealRecipe, {
      mealId,
      recipeId,
      scale: input.scale,
      sortOrder: input.sortOrder ?? null,
    });
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: mealId,
      action: "update",
    });
  });
  return requireMeal(db, mealId);
};

/** Resolve the parent meal of a (non-deleted) meal-recipe row. */
const getMealIdForRecipe = async (
  db: Database,
  id: MealRecipeId,
): Promise<MealId> => {
  const row = await getDb(db).query.mealRecipe.findFirst({
    where: and(eq(mealRecipe.id, id), notDeleted(mealRecipe)),
    columns: { mealId: true },
  });
  if (!row) {
    throw createAppError(
      "MEAL_RECIPE_NOT_FOUND",
      `Meal recipe ${id} not found`,
    );
  }
  return row.mealId;
};

const updateMealRecipe = async (
  db: Database,
  id: MealRecipeId,
  data: { scale?: number; sortOrder?: number | null },
  actor: ActorContext,
): Promise<MealOut> => {
  const mealId = await getMealIdForRecipe(db, id);
  await withTransaction(db, async (tx) => {
    await updateAndReturn(
      tx,
      mealRecipe,
      {
        ...(data.scale !== undefined ? { scale: data.scale } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      },
      eq(mealRecipe.id, id),
    );
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: mealId,
      action: "update",
    });
  });
  return requireMeal(db, mealId);
};

export const updateMealRecipeWithEntityId = async (
  db: Database,
  id: MealRecipeId,
  data: { scale?: number; sortOrder?: number | null },
  actor: ActorContext,
): Promise<MealMutationResult> => {
  const output = await updateMealRecipe(db, id, data, actor);
  const mealId = await getMealIdForRecipe(db, id);
  return { output, entityId: mealId };
};

const removeMealRecipe = async (
  db: Database,
  id: MealRecipeId,
  actor: ActorContext,
): Promise<MealOut> => {
  const mealId = await getMealIdForRecipe(db, id);
  await withTransaction(db, async (tx) => {
    await tx
      .update(mealRecipe)
      .set({ deletedAt: new Date() })
      .where(eq(mealRecipe.id, id));
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: mealId,
      action: "update",
    });
  });
  return requireMeal(db, mealId);
};

export const removeMealRecipeWithEntityId = async (
  db: Database,
  id: MealRecipeId,
  actor: ActorContext,
): Promise<MealMutationResult> => {
  const mealId = await getMealIdForRecipe(db, id);
  const output = await removeMealRecipe(db, id, actor);
  return { output, entityId: mealId };
};

/**
 * What {@link deleteMeals} would do to the given meals, without doing it.
 *
 * Reads the SAME `MEAL_DELETE_EDGE_POLICY` `deleteMeals` is described by. Its
 * one incoming edge, `MealRecipe.mealId`, is a `soft-delete` cascade — there
 * is nothing to block on, so `blockers` is always empty — counted with the
 * identical `inArray(mealRecipe.mealId, ids) AND notDeleted(mealRecipe)`
 * predicate `deleteMeals` updates with (via {@link countByTarget}).
 *
 * Advisory only. `deleteMeals` still re-runs its own cascade inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteMeals = async (
  db: Database,
  ids: MealId[],
): Promise<{ blockers: ImpactItem[]; changes: ImpactItem[] }> => {
  if (ids.length === 0) return { blockers: [], changes: [] };

  const disposition = MEAL_DELETE_EDGE_POLICY["MealRecipe.mealId"];
  const changes = present([
    impact({
      disposition,
      edgeKey: "MealRecipe.mealId",
      label: "planned recipes",
      byTargetId: await countByTarget(
        getDb(db),
        mealRecipe,
        mealRecipe.mealId,
        ids,
      ),
    }),
  ]);

  return { blockers: [], changes };
};
