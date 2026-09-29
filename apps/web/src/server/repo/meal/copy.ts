import type { ActorContext } from "@cubby/schemas/context";
import {
  type MealId,
  type MealRecipeId,
  type MealShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import { shiftPlainDate } from "~/lib/plain-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  meal,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  recipe,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  insertAndReturn,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/** A copy that must stay a plan-sized write: a couple of months of meals. */
const MAX_COPY_RANGE_DAYS = 62;

const DAY_MS = 86_400_000;

const utcDay = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
};

const dayDistance = (from: string, to: string) =>
  Math.round((utcDay(to) - utcDay(from)) / DAY_MS);

export type CopiedMeals = {
  mealIds: MealId[];
  mealShortcodes: MealShortcode[];
  /** Portions dropped because their source or target meal was not copied. */
  skippedPortions: number;
};

/**
 * Copy live meals as new plans on `targetDate(source.date)`. Everything is
 * copied as planned: recipes (scale, order), food entries, and eater portions
 * with `confirmedAt` cleared. Images and yield measurements stay behind — a
 * copy is a plan, not a record of what happened. Copies append; existing
 * meals on the target days are untouched.
 *
 * A portion joins two meals (served at one, sourced from a recipe occurrence
 * in another), so it is re-created against the NEW occurrence and meal ids only
 * when both ends were copied; otherwise it would point back into the original
 * and draw down a batch it was never planned against.
 */
const copyMealsTx = async (
  tx: DrizzleTransaction,
  actor: ActorContext,
  sourceIds: readonly MealId[],
  targetDate: (sourceDate: string) => string,
): Promise<CopiedMeals> => {
  if (sourceIds.length === 0)
    return { mealIds: [], mealShortcodes: [], skippedPortions: 0 };
  const sources = await tx
    .select()
    .from(meal)
    .where(and(inArray(meal.id, [...sourceIds]), notDeleted(meal)))
    .orderBy(asc(meal.date), asc(meal.sortOrder), asc(meal.createdAt));

  const mealMap = new Map<MealId, MealId>();
  const shortcodeMap = new Map<MealId, MealShortcode>();
  for (const source of sources) {
    const created = await insertWithShortcode(tx, "meal", {
      date: targetDate(source.date),
      name: source.name,
      sortOrder: source.sortOrder,
      mealType: source.mealType,
      mealKind: source.mealKind,
    });
    mealMap.set(source.id, created.id);
    shortcodeMap.set(source.id, parseShortcodeFor("meal", created.shortcode));
    await logAuditEntry(tx, actor, {
      entityKind: "meal",
      entityId: created.id,
      action: "create",
    });
  }
  const copiedSourceIds = [...mealMap.keys()];

  const occurrences = await tx
    .select({ occurrence: mealRecipe })
    .from(mealRecipe)
    .innerJoin(
      recipe,
      and(eq(recipe.id, mealRecipe.recipeId), notDeleted(recipe)),
    )
    .where(
      and(inArray(mealRecipe.mealId, copiedSourceIds), notDeleted(mealRecipe)),
    )
    .orderBy(asc(mealRecipe.sortOrder), asc(mealRecipe.createdAt));
  const occurrenceMap = new Map<MealRecipeId, MealRecipeId>();
  for (const { occurrence } of occurrences) {
    const created = await insertAndReturn(tx, mealRecipe, {
      mealId: mealMap.get(occurrence.mealId)!,
      recipeId: occurrence.recipeId,
      scale: occurrence.scale,
      sortOrder: occurrence.sortOrder,
    });
    occurrenceMap.set(occurrence.id, created.id);
  }

  const foods = await tx
    .select()
    .from(mealFoodEntry)
    .where(
      and(
        inArray(mealFoodEntry.mealId, copiedSourceIds),
        notDeleted(mealFoodEntry),
      ),
    )
    .orderBy(asc(mealFoodEntry.createdAt));
  if (foods.length > 0) {
    await tx.insert(mealFoodEntry).values(
      foods.map((food) => ({
        mealId: mealMap.get(food.mealId)!,
        ledgerPartyId: food.ledgerPartyId,
        sourceKind: food.sourceKind,
        ingredientId: food.ingredientId,
        productId: food.productId,
        amountValue: food.amountValue,
        amountUnit: food.amountUnit,
        name: food.name,
        nutrients: food.nutrients,
      })),
    );
  }

  const portions = await tx
    .select()
    .from(mealRecipePortion)
    .where(
      and(
        inArray(mealRecipePortion.mealId, copiedSourceIds),
        notDeleted(mealRecipePortion),
      ),
    )
    .orderBy(asc(mealRecipePortion.createdAt));
  const copiable = portions.flatMap((portion) => {
    const mealRecipeId = occurrenceMap.get(portion.mealRecipeId);
    return mealRecipeId ? [{ portion, mealRecipeId }] : [];
  });
  if (copiable.length > 0) {
    await tx.insert(mealRecipePortion).values(
      copiable.map(({ portion, mealRecipeId }) => ({
        mealRecipeId,
        mealId: mealMap.get(portion.mealId)!,
        ledgerPartyId: portion.ledgerPartyId,
        amountValue: portion.amountValue,
        amountUnit: portion.amountUnit,
        confirmedAt: null,
      })),
    );
  }

  return {
    mealIds: sources.map((source) => mealMap.get(source.id)!),
    mealShortcodes: sources.map((source) => shortcodeMap.get(source.id)!),
    skippedPortions: portions.length - copiable.length,
  };
};

/** A new plan from one meal, on `date` (default: the same day). */
export const duplicateMeal = (
  db: Database,
  actor: ActorContext,
  mealId: MealId,
  date?: string,
): Promise<CopiedMeals> =>
  withTransaction(db, async (tx) => {
    const copied = await copyMealsTx(
      tx,
      actor,
      [mealId],
      (sourceDate) => date ?? sourceDate,
    );
    if (copied.mealIds.length === 0)
      throw createAppError("MEAL_NOT_FOUND", `Meal ${mealId} not found`);
    return copied;
  });

/**
 * Copy every meal dated `from`..`to` (inclusive) so the range starts on
 * `targetFrom`, keeping each meal's offset within it.
 */
export const copyMealRange = (
  db: Database,
  actor: ActorContext,
  range: { from: string; to: string; targetFrom: string },
): Promise<CopiedMeals> => {
  const span = dayDistance(range.from, range.to);
  if (span < 0)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Copy range ends (${range.to}) before it starts (${range.from}).`,
    );
  if (span >= MAX_COPY_RANGE_DAYS)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Copy range spans ${span + 1} days; the limit is ${MAX_COPY_RANGE_DAYS}.`,
    );
  const offset = dayDistance(range.from, range.targetFrom);
  return withTransaction(db, async (tx) => {
    const inRange = await tx
      .select({ id: meal.id })
      .from(meal)
      .where(
        and(
          gte(meal.date, range.from),
          lte(meal.date, range.to),
          notDeleted(meal),
        ),
      );
    return copyMealsTx(
      tx,
      actor,
      inRange.map((row) => row.id),
      (sourceDate) => shiftPlainDate(sourceDate, offset),
    );
  });
};
