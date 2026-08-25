import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { MealId, MealRecipeId } from "@cubby/schemas/identifiers";
import type {
  MealCreateInput,
  MealFilters,
  MealKind,
  MealOut,
  MealRecipeInput,
  MealType,
  UpcomingMealSummaryOut,
} from "@cubby/schemas/meal";
import { mealSortableFields } from "@cubby/schemas/meal";
import { mealTypeValues } from "@cubby/schemas/meal-classification";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { meal, mealRecipe, recipe } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  buildOrderBy,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  getDb,
  insertAndReturn,
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  updateAndReturn,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
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

/** Compact, bounded Home projection over the same canonical date ordering. */
export const getUpcomingMealSummary = async (
  db: Database,
  from: string,
  to: string,
  limit = 4,
): Promise<UpcomingMealSummaryOut> => {
  const rows = await getDb(db).query.meal.findMany({
    where: and(gte(meal.date, from), lte(meal.date, to), notDeleted(meal)),
    orderBy: (m, { asc }) => [asc(m.date), asc(m.sortOrder), asc(m.createdAt)],
    limit,
    ...relations.meal.full,
  });
  return rows.map((row) => {
    const full = dbMealToAPI(row);
    return {
      id: full.id,
      date: full.date,
      name: full.name,
      mealType: full.mealType,
      mealKind: full.mealKind,
      totals: full.totals,
    };
  });
};

export const mealList = async (
  db: Database,
  filters: MealFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
): Promise<{ data: MealOut[]; count: number }> => {
  const dbClient = getDb(db);
  const mealsWithUnderstatedRecipeCost = dbClient
    .select({ mealId: mealRecipe.mealId })
    .from(mealRecipe)
    .innerJoin(
      recipe,
      and(eq(recipe.id, mealRecipe.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(mealRecipe),
        sql`(${recipe.totals} ->> 'costCovered')::int < (${recipe.totals} ->> 'ingredientCount')::int`,
      ),
    );
  // `mealType` must sort by slot, not by slug: a plain text ordering puts
  // dessert before dinner, which reads as a broken table. `mealTypeValues`
  // declaration order IS clock order (the calendar sorts a day by it), so
  // `array_position` over that tuple is the same ranking `mealTypeRank`
  // applies client-side. Unslotted meals sort last in both directions.
  const resolveMealSort = (s: SortParams): SQL[] | null => {
    if (s.orderBy !== "mealType") return null;
    const rank = sql`array_position(${sql.raw(
      `ARRAY[${mealTypeValues.map((v) => `'${v}'`).join(",")}]::text[]`,
    )}, ${meal.mealType})`;
    return [
      s.direction === "asc"
        ? sql`${rank} asc nulls last`
        : sql`${rank} desc nulls last`,
    ];
  };
  const orderByArray = buildOrderBy(meal, sorts, [...mealSortableFields], {
    resolve: resolveMealSort,
    // An unnamed meal displays as its date, so a name sort would otherwise
    // dump every one of them into an arbitrarily-ordered NULL block. This
    // orders that block the way its visible label reads.
    tieBreaker: sql`${meal.date} desc`,
  });
  const { take, skip } = buildTakeSkip(pagination);

  const whereCondition = and(
    notDeleted(meal),
    ...auditDateWhereConditions(meal, filters),
    // `mealFilterFields` spreads `mealRelatedFilterFields` (the recipe trio) and
    // the manifest renders its control — omitting this is the #588 drift, where
    // the UI sends a filter the server silently ignores.
    ...relatedWhereConditions("meal", filters, meal.id),
    // OR-ed, not narrowed: "unslotted" is a value of the same picker, so
    // selecting it alongside `dinner` means "dinner or unslotted".
    eqAnyOrPresence(
      meal.mealType,
      filters.mealType,
      filters.mealTypePresenceFilter,
    ),
    eqAny(meal.mealKind, filters.mealKind),
    filters.from ? gte(meal.date, filters.from) : undefined,
    filters.to ? lte(meal.date, filters.to) : undefined,
    filters.recipeCostCoverage === "understated"
      ? inArray(meal.id, mealsWithUnderstatedRecipeCost)
      : undefined,
  );

  const { data: rows, count } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      dbClient.query.meal.findMany({
        where: whereCondition,
        orderBy: orderByArray,
        limit: take,
        offset: skip,
        ...relations.meal.full,
      }),
    count: () => countWhere(db, meal, whereCondition),
  });

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
      mealType: data.mealType ?? null,
      // Omitted rather than coalesced — let the column default supply "cooked"
      // in one place instead of restating it here.
      ...(data.mealKind !== undefined ? { mealKind: data.mealKind } : {}),
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
  data: {
    date?: string;
    name?: string | null;
    sortOrder?: number | null;
    mealType?: MealType | null;
    mealKind?: MealKind;
  },
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
        ...(data.mealType !== undefined ? { mealType: data.mealType } : {}),
        ...(data.mealKind !== undefined ? { mealKind: data.mealKind } : {}),
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
): Promise<{ deleted: number }> => {
  if (ids.length === 0) return { deleted: 0 };
  return await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, meal, ids, "Meal");
    // The meal manifest has onDelete: [], so this transaction is the only place
    // a meal's EntityEmbedding row gets cleaned up. And because
    // `removeMealRecipe` unplans rows singly, a meal can already own dead
    // MealRecipe rows — the soft cascade's `notDeleted` is what preserves them.
    const { deleted } = await removeEntity(tx, {
      entity: "meal",
      ids,
      removal: "soft",
      actor,
      children: [
        {
          table: mealRecipe,
          parentColumns: [mealRecipe.mealId],
          auditKey: "cascadedMealRecipes",
        },
      ],
    });
    return { deleted };
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
    // Repeats are INTENTIONAL, not a duplicate bug: a meal may serve the same
    // recipe more than once at different scales, and each occurrence must stay
    // a distinguishable shopping-list contribution. Guard-backed by
    // "gives each planned line its own index when a meal repeats a recipe"
    // (api/routers/meal.integration.test.ts). So no unique index on
    // (mealId, recipeId) and no upsert — retry-safety for a re-sent MCP call
    // would need an explicit idempotency key, which this deliberately is not.
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
