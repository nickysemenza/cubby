import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  ImageShortcode,
  MealId,
  MealRecipeId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  MealCreateInput,
  MealFilters,
  MealOut,
  MealRecipeInput,
  MealUpdateInput,
  UpcomingMealSummaryOut,
} from "@cubby/schemas/meal";
import { mealTypeValues } from "@cubby/schemas/meal-classification";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, gte, inArray, lte, or, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  meal,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  recipe,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  associatePendingImages,
  getDb,
  imageCascadeChild,
  imageJoinBindings,
  insertAndReturn,
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  syncEntityImages,
  updateAndReturn,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list-scaffold";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { dbMealToAPI, rollupMealTotals } from "./helpers";

type MealMutationResult = { output: MealOut; entityId: MealId };

/** A protocol adapter may compare its stale projection while this update owns
 * the row lock. The Meal repository remains the only owner of writes. */
export type MealMutationHooks = {
  beforeUpdate?: (tx: DrizzleTransaction, id: MealId) => Promise<void>;
};

/** The scalar-column subset of `MealUpdateInput["data"]` — everything except
 * the image write fields, which `syncEntityImages` handles separately. */
type MealColumnPatch = {
  date?: string;
  name?: string | null;
  sortOrder?: number | null;
  mealType?: MealCreateInput["mealType"];
  mealKind?: MealCreateInput["mealKind"];
};

export const MEAL_DELETE_EDGE_POLICY = {
  "MealFoodEntry.mealId": {
    code: "soft-delete-food-entries",
    effect: "soft-delete",
    description:
      "Deleting a meal soft-deletes its product and manual food entries.",
  },
  "MealRecipe.mealId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Deleting a meal soft-deletes its planned recipes; the recipes themselves are untouched.",
  },
  "MealRecipePortion.mealId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Deleting a meal soft-deletes portions served at it; their source preparations are untouched.",
  },
  "EntityAttachment.subjectEntityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the meal, and each file is\n      deleted too unless something else still references it.",
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
  fromDB: async (db, row) => {
    const qualities = await loadDataQualities(db, "meal", [row.id]);
    // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
    return dbMealToAPI(row, qualities.get(row.id)!);
  },
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
  const qualities = await loadDataQualities(
    db,
    "meal",
    rows.map((row) => row.id),
  );
  // SAFETY: `row` came from `rows`, which `qualities` was loaded for.
  return rows.map((row) => dbMealToAPI(row, qualities.get(row.id)!));
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
    columns: {
      shortcode: true,
      date: true,
      name: true,
      mealType: true,
      mealKind: true,
    },
    with: {
      recipes: {
        where: notDeleted(mealRecipe),
        columns: { scale: true, deletedAt: true },
        with: {
          recipe: {
            columns: {
              totals: true,
              totalsComputedAt: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: parseShortcodeFor("meal", row.shortcode),
    date: row.date,
    name: row.name,
    mealType: row.mealType,
    mealKind: row.mealKind,
    totals: rollupMealTotals(row.recipes),
  }));
};

const mealScaffold = listScaffold("meal", meal);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildMealWhere = (
  db: Database,
  filters: MealFilters,
): SQL | undefined => {
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
        // Unavailable costs count only when the engine recorded contributors
        // (`coverage.total`, 0 of N priced). Legacy rows lacking the key stay
        // out until "Recompute all recipe totals" or repair-on-read rewrites them.
        or(
          sql`${recipe.totals} -> 'cost' ->> 'status' = 'partial'`,
          and(
            sql`${recipe.totals} -> 'cost' ->> 'status' = 'unavailable'`,
            sql`COALESCE((${recipe.totals} #>> '{cost,coverage,total}')::int, 0) > 0`,
          ),
        ),
      ),
    );

  // `mealType` (OR-ed with its presence filter — "unslotted" is a value of the
  // same picker, so selecting it alongside `dinner` means "dinner or
  // unslotted") and `mealKind` are declared stored filters — applied by
  // `mealScaffold.where` before the conditions below.
  return mealScaffold.where(filters, [
    // `mealFilterFields` spreads `mealRelatedFilterFields` (the recipe trio) and
    // the manifest renders its control — omitting this is the #588 drift, where
    // the UI sends a filter the server silently ignores.
    ...relatedWhereConditions("meal", filters, meal.id),
    filters.from ? gte(meal.date, filters.from) : undefined,
    filters.to ? lte(meal.date, filters.to) : undefined,
    filters.recipeCostCoverage === "understated"
      ? inArray(meal.id, mealsWithUnderstatedRecipeCost)
      : undefined,
  ]);
};

export const mealList = async (
  db: Database,
  filters: MealFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) => {
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
  return mealScaffold.list(
    db,
    { filters, sorts, pagination, readIntent },
    {
      where: buildMealWhere(db, filters),
      resolveSort: resolveMealSort,
      // An unnamed meal displays as its date, so a name sort would otherwise
      // dump every one of them into an arbitrarily-ordered NULL block. This
      // orders that block the way its visible label reads.
      tieBreaker: sql`${meal.date} desc`,
      select: (page) =>
        getDb(db).query.meal.findMany({ ...page, ...relations.meal.full }),
      hydrate: async (rows) => {
        const qualities = await loadDataQualities(
          db,
          "meal",
          rows.map((row) => row.id),
        );
        return withDisplayImages(db, "meal", rows, (row) =>
          // SAFETY: `row` came from `rows`, which `qualities` was loaded for.
          dbMealToAPI(row, qualities.get(row.id)!),
        );
      },
    },
  );
};

export const createMealWithEntityId = async (
  db: Database,
  data: MealCreateInput,
  actor: ActorContext,
): Promise<MealMutationResult> => {
  const id = await withTransaction(db, async (tx) => {
    const mealValues = {
      date: data.date,
      name: data.name ?? null,
      sortOrder: data.sortOrder ?? null,
      mealType: data.mealType ?? null,
    };
    // Omitted rather than coalesced — let the column default supply "cooked"
    // in one place instead of restating it here.
    if (data.mealKind !== undefined) {
      Object.assign(mealValues, { mealKind: data.mealKind });
    }
    const created = await insertWithShortcode(tx, "meal", mealValues);
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
    if (data.pendingImageIds && data.pendingImageIds.length > 0) {
      const resolvedImageIds = await resolveAllPresent(
        tx,
        "image",
        data.pendingImageIds,
      );
      await associatePendingImages(
        tx,
        imageJoinBindings.meal,
        created.id,
        resolvedImageIds,
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
  data: MealUpdateInput["data"],
  actor: ActorContext,
  hooks?: MealMutationHooks,
): Promise<{ meal: MealOut; detachedImageKeys: string[] }> => {
  let detachedImageKeys: string[] = [];
  // Mutation + audit in one transaction so the change is never left unrecorded.
  await withTransaction(db, async (tx) => {
    await hooks?.beforeUpdate?.(tx, id);
    const mealPatch: MealColumnPatch = {};
    if (data.date !== undefined) mealPatch.date = data.date;
    if (data.name !== undefined) mealPatch.name = data.name;
    if (data.sortOrder !== undefined) mealPatch.sortOrder = data.sortOrder;
    if (data.mealType !== undefined) mealPatch.mealType = data.mealType;
    if (data.mealKind !== undefined) mealPatch.mealKind = data.mealKind;
    await updateLiveAndReturn(tx, meal, mealPatch, id);
    ({ detachedImageKeys } = await syncEntityImages(
      tx,
      "meal",
      imageJoinBindings.meal,
      id,
      data,
    ));
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: id,
      action: "update",
    });
  });
  return { meal: await requireMeal(db, id), detachedImageKeys };
};

/**
 * Soft-delete meals and cascade-soft-delete their planned recipes, all in one
 * transaction. Mirrors how other entity deletes cascade to their children.
 */
export const deleteMeals = async (
  db: Database,
  ids: MealId[],
  actor: ActorContext,
): Promise<{
  deleted: number;
  detachedImageKeys: string[];
  deletedImageShortcodes: ImageShortcode[];
}> => {
  if (ids.length === 0)
    return { deleted: 0, detachedImageKeys: [], deletedImageShortcodes: [] };
  return await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, meal, ids, "Meal");
    const sourceOccurrences = await tx
      .select({ id: mealRecipe.id })
      .from(mealRecipe)
      .where(and(inArray(mealRecipe.mealId, ids), notDeleted(mealRecipe)))
      .orderBy(mealRecipe.id)
      .for("update");
    const sourceOccurrenceIds = sourceOccurrences.map((row) => row.id);
    const now = new Date();
    // A portion has two independent meanings: it is served at its target Meal
    // and sourced from its MealRecipe. Removing the source Meal removes both
    // sides; a portion targeted at a different Meal remains only when its
    // source occurrence remains live.
    if (sourceOccurrenceIds.length > 0)
      await tx
        .update(mealRecipePortion)
        .set({ deletedAt: now })
        .where(
          and(
            inArray(mealRecipePortion.mealRecipeId, sourceOccurrenceIds),
            notDeleted(mealRecipePortion),
          ),
        );
    // The meal manifest has onDelete: [], so this transaction is the only place
    // a meal's EntityEmbedding row gets cleaned up. And because
    // `removeMealRecipe` unplans rows singly, a meal can already own dead
    // MealRecipe rows — the soft cascade's `notDeleted` is what preserves them.
    const { deleted, detachedImageKeys, deletedImageShortcodes } =
      await removeEntity(tx, {
        entity: "meal",
        ids,
        removal: "soft",
        actor,
        children: [
          {
            table: mealFoodEntry,
            parentColumns: [mealFoodEntry.mealId],
            auditKey: "cascadedMealFoodEntries",
          },
          {
            table: mealRecipe,
            parentColumns: [mealRecipe.mealId],
            auditKey: "cascadedMealRecipes",
          },
          {
            table: mealRecipePortion,
            parentColumns: [mealRecipePortion.mealId],
            auditKey: "cascadedMealRecipePortions",
          },
          imageCascadeChild(),
        ],
      });
    return { deleted, detachedImageKeys, deletedImageShortcodes };
  });
};

export const addRecipeToMeal = async (
  db: Database,
  mealId: MealId,
  input: MealRecipeInput,
  actor: ActorContext,
): Promise<{ meal: MealOut; mealRecipeId: MealRecipeId }> => {
  const mealRecipeId = await withTransaction(db, async (tx) => {
    const recipeId = await resolveOrThrow(tx, "recipe", input.recipeId);
    // Repeats are INTENTIONAL, not a duplicate bug: a meal may serve the same
    // recipe more than once at different scales, and each occurrence must stay
    // a distinguishable shopping-list contribution. Guard-backed by
    // "returns distinct occurrence handles for repeated recipes and preserves shopping contributions"
    // (repo/meal.integration.test.ts). So no unique index on
    // (mealId, recipeId) and no upsert — retry-safety for a re-sent MCP call
    // would need an explicit idempotency key, which this deliberately is not.
    const occurrence = await insertAndReturn(tx, mealRecipe, {
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
    return occurrence.id;
  });
  return { meal: await requireMeal(db, mealId), mealRecipeId };
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
    const recipePatch: typeof data = {};
    if (data.scale !== undefined) recipePatch.scale = data.scale;
    if (data.sortOrder !== undefined) recipePatch.sortOrder = data.sortOrder;
    await updateAndReturn(tx, mealRecipe, recipePatch, eq(mealRecipe.id, id));
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
    const [lockedMeal] = await tx
      .select({ id: meal.id })
      .from(meal)
      .where(and(eq(meal.id, mealId), notDeleted(meal)))
      .for("key share");
    if (!lockedMeal) throw createAppError("MEAL_NOT_FOUND", "Meal not found");
    const [lockedOccurrence] = await tx
      .select({ id: mealRecipe.id })
      .from(mealRecipe)
      .where(
        and(
          eq(mealRecipe.id, id),
          eq(mealRecipe.mealId, mealId),
          notDeleted(mealRecipe),
        ),
      )
      .for("update");
    if (!lockedOccurrence)
      throw createAppError("MEAL_RECIPE_NOT_FOUND", "Meal recipe not found");
    const now = new Date();
    await tx
      .update(mealRecipePortion)
      .set({ deletedAt: now })
      .where(
        and(
          eq(mealRecipePortion.mealRecipeId, id),
          notDeleted(mealRecipePortion),
        ),
      );
    await tx
      .update(mealRecipe)
      .set({ deletedAt: now })
      .where(and(eq(mealRecipe.id, id), notDeleted(mealRecipe)));
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
