import type { ActorContext } from "@cubby/schemas/context";
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
import { meal, mealRecipe } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries, logAuditEntry } from "~/server/repo/audit-log";
import {
  buildOrderBy,
  countWhere,
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
import { dbMealToAPI } from "./helpers";

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
  entityName: "meal",
  fetchById: fetchMealById,
  fromDB: (_db, row) => dbMealToAPI(row),
  notFoundReason: "MEAL_NOT_FOUND",
});

export const getMealByID = (
  db: Database,
  id: MealId,
): Promise<MealOut | null> => mealReader.getByIDOrNull(db, id);

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
  sort: SortParams,
  pagination: PaginationParams,
): Promise<{ data: MealOut[]; count: number }> => {
  const orderByArray = buildOrderBy(meal, sort, [...mealSortableFields]);
  const { take, skip } = buildTakeSkip(pagination);

  const whereCondition = and(
    notDeleted(meal),
    filters.from ? gte(meal.date, filters.from) : undefined,
    filters.to ? lte(meal.date, filters.to) : undefined,
  );

  const [rows, count] = await Promise.all([
    getDb(db).query.meal.findMany({
      where: whereCondition,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.meal.full,
    }),
    countWhere(db, meal, whereCondition),
  ]);

  return { data: rows.map(dbMealToAPI), count };
};

export const createMeal = async (
  db: Database,
  data: MealCreateInput,
  actor: ActorContext,
): Promise<MealOut> => {
  const id = await withTransaction(db, async (tx) => {
    const created = await insertAndReturn(tx, meal, {
      date: data.date,
      name: data.name ?? null,
      sortOrder: data.sortOrder ?? null,
    });
    if (data.recipes?.length) {
      await tx.insert(mealRecipe).values(
        data.recipes.map((r) => ({
          mealId: created.id,
          recipeId: r.recipeId,
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
  return requireMeal(db, id);
};

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
    await insertAndReturn(tx, mealRecipe, {
      mealId,
      recipeId: input.recipeId,
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

export const updateMealRecipe = async (
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

export const removeMealRecipe = async (
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
