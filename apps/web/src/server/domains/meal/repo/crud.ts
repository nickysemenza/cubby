import type { ActorContext } from "@cubby/schemas/context";
import {
  type MealCreateInput,
  type MealUpdateInput,
} from "@cubby/schemas/entities/meal";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { MealId, MealRecipeId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { MealRecipeInput } from "@cubby/schemas/meal";
import { mealTypeValues } from "@cubby/schemas/meal-classification";
import {
  rawMealList,
  rawMealOutput,
  type RawMealOutput,
  type RawUpcomingMealSummary,
} from "@cubby/schemas/meal-raw-read";
import { and, asc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { trimTextSql } from "~/server/db/computed/text-whitespace";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  associatePendingImages,
  mapImages,
  getDb,
  galleryBinding,
  insertAndReturn,
  notDeleted,
  relations,
  updateAndReturn,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import { meal, mealRecipe, mealRecipePortion } from "~/server/db/schema";
import { syncEntityImages } from "~/server/domains/image/repo/entity-image-sync";
import { mealSearch } from "~/server/domains/meal/repo/search-read-meal";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { gapCondition } from "~/server/generic/data-quality/repo/sql";
import { listScaffold } from "~/server/generic/list/repo/list";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  rollupMealTotals,
  mealRecipeFields,
  mealTotalsFields,
} from "./helpers";

type MealMutationResult = { output: RawMealOutput; entityId: MealId };

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
  "EntityAttachment.entityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the meal, and each file is\n      deleted too unless something else still references it.",
  },
} as const satisfies IncomingEdgePolicy<"meal", OperationDisposition>;

// `mealType` must sort by slot, not by slug: a plain text ordering puts
// dessert before dinner, which reads as a broken table. `mealTypeValues`
// declaration order IS clock order (the calendar sorts a day by it), so
// `array_position` over that tuple is the same ranking `mealTypeRank`
// applies client-side. Unslotted meals sort last in both directions.
export const mealScaffold = listScaffold("meal", meal, {
  derived: {
    mealType: sql`array_position(${sql.raw(
      `ARRAY[${mealTypeValues.map((v) => `'${v}'`).join(",")}]::text[]`,
    )}, ${meal.mealType})`,
    recipeCostCoverage: gapCondition(
      "meal",
      "meal_recipe_cost_incomplete",
      meal,
    ),
  },
  read: {
    title: sql`COALESCE(NULLIF(${trimTextSql(meal.name)}, ''), ${meal.date}::text)`,
    search: mealSearch,
    // The derived `mealType` is the slot's sort rank; the read keeps the slot.
    columns: { mealType: meal.mealType },
    // An unnamed meal displays as its date, so a name sort would otherwise
    // dump every one of them into an arbitrarily-ordered NULL block. This
    // orders that block the way its visible label reads.
    tieBreaker: sql`${meal.date} desc`,
    media: true,
    bindings: (bind) => {
      const planned = bind.ids(async ({ db, ids }) => {
        const rows = await unwrapDb(db).query.meal.findMany({
          where: inArray(
            meal.id,
            ids.map((id) => parseEntityId("meal", id)),
          ),
          columns: { id: true, shortcode: true },
          with: { recipes: relations.meal.full.with.recipes },
        });
        return new Map(rows.map((row) => [row.id, mealRecipeFields(row)]));
      });
      const attachments = bind.ids(async ({ db, ids }) => {
        const rows = await unwrapDb(db).query.meal.findMany({
          where: inArray(
            meal.id,
            ids.map((id) => parseEntityId("meal", id)),
          ),
          columns: { id: true },
          with: { images: relations.meal.full.with.images },
        });
        return new Map(rows.map((row) => [row.id, mapImages(row.images)]));
      });
      return [
        bind(rawMealList.pick({ displayName: true }), (row) => ({
          displayName: row.name?.trim() || row.date,
        })),
        planned.fields(
          rawMealList.pick({ recipes: true, recipeNames: true }),
          (row, loaded) => {
            const values = loaded.get(row.id);
            if (!values) throw new Error("Meal recipes were not loaded");
            return values;
          },
        ),
        planned.fields(
          rawMealList.pick({
            totals: true,
            cost: true,
            calories: true,
            costTotalLabel: true,
          }),
          (row, loaded) => {
            const values = loaded.get(row.id);
            if (!values) throw new Error("Meal totals require loaded recipes");
            return mealTotalsFields(values.recipes);
          },
        ),
        attachments.fields(
          rawMealList.pick({ images: true }),
          (row, loaded) => ({
            images: loaded.get(row.id) ?? [],
          }),
        ),
      ];
    },
  },
});

// Read path through the shared reader. The write path stays hand-rolled: meal
// create/update/delete manage mealRecipe children inside a transaction.
const mealReader = createEntityReader({
  entity: "meal",
  scaffold: mealScaffold,
  output: rawMealOutput,
});

/** One live Meal by internal id, or null. */
export const readMealById = mealReader.getByIDOrNull;

/** Throws MEAL_NOT_FOUND if the meal is missing — for callers that need a value. */
const requireMeal = (db: Database, id: MealId): Promise<RawMealOutput> =>
  mealReader.getByID(db, id);

/** Meals whose date falls within [from, to] (inclusive) — the calendar query. */
// Bounds are "YYYY-MM-DD" strings compared against the date column (ISO date
// strings sort chronologically), so the calendar query has no timezone shift.
export const getMealsByDateRange = async (
  db: Database,
  from: string,
  to: string,
  condition?: SQL,
): Promise<RawMealOutput[]> => {
  const rows = await getDb(db)
    .select({ id: meal.id })
    .from(meal)
    .where(
      and(
        gte(meal.date, from),
        lte(meal.date, to),
        notDeleted(meal),
        condition,
      ),
    )
    .orderBy(asc(meal.date), asc(meal.sortOrder), asc(meal.createdAt));
  const read = await mealScaffold.getByIds(
    db,
    rows.map((row) => row.id),
  );
  return read.data.map((row) => rawMealOutput.parse(row));
};

/** Compact, bounded Home projection over the same canonical date ordering. */
export const getUpcomingMealSummary = async (
  db: Database,
  from: string,
  to: string,
  limit = 4,
): Promise<RawUpcomingMealSummary[]> => {
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

export const createMealWithEntityId = defineMutationWriter({
  entity: "meal",
  read: async (
    receipt: MutationReceipt<"meal">,
    db: Database,
    _data: MealCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await requireMeal(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: MealCreateInput,
    actor: ActorContext,
  ) => {
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
          galleryBinding("meal"),
          created.id,
          resolvedImageIds,
        );
      }
      await logAuditEntry(tx, actor, {
        entityKind: "meal",
        entityId: created.id,
        action: "create",
      });
      return created.id;
    });
    return readOutput({ entityId: id });
  },
});

export const updateMeal = defineMutationWriter({
  entity: "meal",
  read: async (
    receipt: MutationReceipt<"meal">,
    db: Database,
    _id: MealId,
    _data: MealUpdateInput["data"],
    _actor: ActorContext,
    _hooks?: MealMutationHooks,
  ) => ({
    meal: await requireMeal(db, receipt.entityId),
    detachedImageKeys: receipt.detachedImageKeys ?? [],
  }),
  write: async (
    readOutput,
    db: Database,
    id: MealId,
    data: MealUpdateInput["data"],
    actor: ActorContext,
    hooks?: MealMutationHooks,
  ) => {
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
        galleryBinding("meal"),
        id,
        data,
      ));
      await logAuditEntry(tx, actor, {
        entityKind: "meal",
        entityId: id,
        action: "update",
      });
    });
    return readOutput({ entityId: id, detachedImageKeys });
  },
  item: (full) => full.meal,
});

/**
 * A portion has two independent meanings: it is served at its target Meal
 * and sourced from its MealRecipe. Removing the source Meal removes both
 * sides; a portion targeted at a different Meal remains only when its source
 * occurrence remains live.
 */
const removeSourcedPortions = async (tx: DrizzleTransaction, ids: MealId[]) => {
  const sourceOccurrences = await tx
    .select({ id: mealRecipe.id })
    .from(mealRecipe)
    .where(and(inArray(mealRecipe.mealId, ids), notDeleted(mealRecipe)))
    .orderBy(mealRecipe.id)
    .for("update");
  if (sourceOccurrences.length === 0) return;
  await tx
    .update(mealRecipePortion)
    .set({ deletedAt: new Date() })
    .where(
      and(
        inArray(
          mealRecipePortion.mealRecipeId,
          sourceOccurrences.map((row) => row.id),
        ),
        notDeleted(mealRecipePortion),
      ),
    );
};

/** Meal deletes take uuids; the policy cascades entries, plans and portions. */
export const deleteMeals = (db: Database, ids: MealId[], actor: ActorContext) =>
  deleteByPolicy(db, {
    entity: "meal",
    policy: MEAL_DELETE_EDGE_POLICY,
    ids,
    actor,
    beforeDelete: removeSourcedPortions,
  });

export const addRecipeToMeal = async (
  db: Database,
  mealId: MealId,
  input: MealRecipeInput,
  actor: ActorContext,
): Promise<{ meal: RawMealOutput; mealRecipeId: MealRecipeId }> => {
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
      entityKind: "meal",
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
): Promise<RawMealOutput> => {
  const mealId = await getMealIdForRecipe(db, id);
  await withTransaction(db, async (tx) => {
    const recipePatch: typeof data = {};
    if (data.scale !== undefined) recipePatch.scale = data.scale;
    if (data.sortOrder !== undefined) recipePatch.sortOrder = data.sortOrder;
    await updateAndReturn(tx, mealRecipe, recipePatch, eq(mealRecipe.id, id));
    await logAuditEntry(tx, actor, {
      entityKind: "meal",
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
): Promise<RawMealOutput> => {
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
      entityKind: "meal",
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
