import type { ActorContext } from "@cubby/schemas/context";
import {
  type MealRecipeId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  type GetMealPreparationsInput,
  type GetMealPreparationsOut,
  getMealPreparationsOut,
  type MealPreparationYieldBasis,
  type SaveMealRecipePreparationInput,
  type SaveMealRecipePreparationOut,
  saveMealRecipePreparationOut,
} from "@cubby/schemas/meal";
import type { MealKind } from "@cubby/schemas/meal-classification";
import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";
import type { RecipeTotals, RecipeYield } from "@cubby/schemas/recipe-shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  aggregateTotals,
  pendingTotals,
  scaleEstimate,
  scaleNutrition,
  scaleTotals,
} from "~/lib/nutrition-estimates";
import { safeConvertAmount } from "~/lib/recipe-costing";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  ledgerParty,
  meal,
  mealRecipe,
  mealRecipePortion,
  recipe,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { lockLedgerPartiesForReference } from "~/server/repo/ledger-party-reference";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { repairStaleRecipesForRead } from "~/server/services/repair-stale-recipes-for-read";

type PortionRow = {
  id: string;
  targetMealId: string;
  targetMealShortcode: string;
  targetMealDate: string;
  targetMealName: string | null;
  targetMealKind: MealKind;
  ledgerPartyId: string;
  ledgerPartyShortcode: string;
  ledgerPartyName: string;
  ledgerPartyKind: "member" | "guest" | "household";
  grams: number;
  confirmedAt: Date | null;
};

const gramsForRecipeYield = (
  yieldAmount: RecipeYield | null,
): {
  lower: number;
  upper: number | null;
} | null => {
  if (!yieldAmount) return null;
  const lowerResult = safeConvertAmount(yieldAmount, [], "weight");
  if (lowerResult.isErr()) return null;
  if (yieldAmount.upperValue == null)
    return { lower: lowerResult.value.value, upper: null };
  const upperResult = safeConvertAmount(
    { value: yieldAmount.upperValue, unit: yieldAmount.unit },
    [],
    "weight",
  );
  if (upperResult.isErr()) return null;
  return {
    lower: lowerResult.value.value,
    upper: upperResult.value.value,
  };
};

export const yieldBasisFor = (
  actualYieldGrams: number | null,
  estimatedYieldGrams: number | null,
  recipeYield: RecipeYield | null,
  scale: number,
): MealPreparationYieldBasis => {
  if (actualYieldGrams != null)
    return { kind: "actual", lowerGrams: actualYieldGrams, upperGrams: null };
  if (estimatedYieldGrams != null)
    return {
      kind: "estimated",
      lowerGrams: estimatedYieldGrams,
      upperGrams: null,
    };
  const recipeGrams = gramsForRecipeYield(recipeYield);
  if (!recipeGrams)
    return { kind: "missing", lowerGrams: null, upperGrams: null };
  return {
    kind: "recipe",
    lowerGrams: recipeGrams.lower * scale,
    upperGrams: recipeGrams.upper == null ? null : recipeGrams.upper * scale,
  };
};

/** Recalculate a preparation from the current recipe totals on every read. */
export const batchTotalsFor = (
  totals: RecipeTotals | null,
  totalsComputedAt: Date | null,
  scale: number,
): NutritionTotals => {
  if (!totals) return pendingTotals("totals_missing");
  if (!totalsComputedAt) return pendingTotals("totals_stale");
  return scaleTotals(totals, scale);
};

export const portionTotalsFor = (
  batch: NutritionTotals,
  yieldBasis: MealPreparationYieldBasis,
  grams: number,
): NutritionTotals => {
  if (yieldBasis.kind === "missing") {
    const estimate = {
      status: "unavailable" as const,
      reason: "yield_missing" as const,
    };
    return { cost: estimate, nutrition: buildNutrition(() => estimate) };
  }
  const upperYield = yieldBasis.upperGrams ?? yieldBasis.lowerGrams;
  const lowerFactor = grams / upperYield;
  const upperFactor = grams / yieldBasis.lowerGrams;
  return {
    cost: scaleEstimate(batch.cost, lowerFactor, upperFactor),
    nutrition: scaleNutrition(batch.nutrition, lowerFactor, upperFactor),
  };
};

const updatePreparationYields = async (
  tx: DrizzleTransaction,
  mealRecipeId: MealRecipeId,
  input: SaveMealRecipePreparationInput,
) => {
  if (
    input.estimatedYieldGrams === undefined &&
    input.actualYieldGrams === undefined
  )
    return;
  if (input.estimatedYieldGrams !== undefined) {
    await tx
      .update(mealRecipe)
      .set({ estimatedYieldGrams: input.estimatedYieldGrams })
      .where(eq(mealRecipe.id, mealRecipeId));
  }
  if (input.actualYieldGrams !== undefined)
    await tx
      .update(mealRecipe)
      .set({ actualYieldGrams: input.actualYieldGrams })
      .where(eq(mealRecipe.id, mealRecipeId));
};

/**
 * Save the preparation facts for one MealRecipe occurrence. Portions are keyed
 * by target meal and eater; all writes and every affected meal audit happen in
 * one transaction so a reassignment cannot leave either meal with a half view.
 */
export const saveMealRecipePreparation = async (
  db: Database,
  input: SaveMealRecipePreparationInput,
  actor: ActorContext,
): Promise<SaveMealRecipePreparationOut> =>
  withTransaction(db, async (tx) => {
    const [candidateOccurrence] = await tx
      .select({
        id: mealRecipe.id,
        mealId: mealRecipe.mealId,
        estimatedYieldGrams: mealRecipe.estimatedYieldGrams,
        actualYieldGrams: mealRecipe.actualYieldGrams,
      })
      .from(mealRecipe)
      .where(
        and(eq(mealRecipe.id, input.mealRecipeId), notDeleted(mealRecipe)),
      );
    if (!candidateOccurrence)
      throw createAppError("MEAL_RECIPE_NOT_FOUND", "Meal recipe not found");

    // Reference locks come first across preparation writes and Ledger Party
    // lifecycle mutations. Meal rows come next, then the owned occurrence.
    // Keeping that order prevents a save from racing a target/source Meal
    // deletion or deadlocking a party merge that folds portions.
    const parties = await lockLedgerPartiesForReference(
      tx,
      input.changes.map((change) => change.ledgerPartyId),
    );
    if (parties.some((party) => party.kind === "household"))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The household ledger party cannot be a meal eater.",
      );
    const targetIds = await resolveAllOrThrow(
      tx,
      "meal",
      input.changes.map((change) => change.mealId),
    );
    const mealIds = [
      ...new Set([candidateOccurrence.mealId, ...targetIds]),
    ].sort();
    const lockedMeals = await tx
      .select({ id: meal.id })
      .from(meal)
      .where(and(inArray(meal.id, mealIds), notDeleted(meal)))
      .orderBy(meal.id)
      .for("key share");
    if (lockedMeals.length !== mealIds.length)
      throw createAppError(
        "MEAL_NOT_FOUND",
        "A source or target meal is no longer live.",
      );

    const [occurrence] = await tx
      .select({
        id: mealRecipe.id,
        mealId: mealRecipe.mealId,
        estimatedYieldGrams: mealRecipe.estimatedYieldGrams,
        actualYieldGrams: mealRecipe.actualYieldGrams,
      })
      .from(mealRecipe)
      .where(and(eq(mealRecipe.id, input.mealRecipeId), notDeleted(mealRecipe)))
      .for("update");
    if (!occurrence || occurrence.mealId !== candidateOccurrence.mealId)
      throw createAppError("MEAL_RECIPE_NOT_FOUND", "Meal recipe not found");

    const existing = await tx
      .select({
        id: mealRecipePortion.id,
        mealId: mealRecipePortion.mealId,
        ledgerPartyId: mealRecipePortion.ledgerPartyId,
        grams: mealRecipePortion.grams,
        confirmedAt: mealRecipePortion.confirmedAt,
      })
      .from(mealRecipePortion)
      .where(
        and(
          eq(mealRecipePortion.mealRecipeId, occurrence.id),
          notDeleted(mealRecipePortion),
        ),
      )
      .orderBy(mealRecipePortion.id)
      .for("update");
    const existingByTargetEater = new Map(
      existing.map((portion) => [
        `${portion.mealId}:${portion.ledgerPartyId}`,
        portion,
      ]),
    );
    const finalGrams = new Map(
      existing.map((portion) => [
        `${portion.mealId}:${portion.ledgerPartyId}`,
        portion.grams,
      ]),
    );
    for (const [index, change] of input.changes.entries()) {
      const targetId = targetIds[index]!;
      const party = parties[index]!;
      const key = `${targetId}:${party.id}`;
      if (change.action === "remove") finalGrams.delete(key);
      else finalGrams.set(key, change.grams);
    }
    const nextActualYield =
      input.actualYieldGrams === undefined
        ? occurrence.actualYieldGrams
        : input.actualYieldGrams;
    const assignedGrams = [...finalGrams.values()].reduce(
      (sum, grams) => sum + grams,
      0,
    );
    if (nextActualYield != null && assignedGrams > nextActualYield)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Assigned portions exceed the actual cooked yield.",
      );

    const now = new Date();
    for (const [index, change] of input.changes.entries()) {
      const targetId = targetIds[index]!;
      const party = parties[index]!;
      const key = `${targetId}:${party.id}`;
      const prior = existingByTargetEater.get(key);
      if (change.action === "remove") {
        if (prior)
          await tx
            .update(mealRecipePortion)
            .set({ deletedAt: now })
            .where(eq(mealRecipePortion.id, prior.id));
        continue;
      }
      // Confirmation is the consumed-at fact, not the last time this form was
      // saved. A later gram correction must not rewrite when it was consumed.
      const confirmedAt = change.confirmed ? (prior?.confirmedAt ?? now) : null;
      if (prior)
        await tx
          .update(mealRecipePortion)
          .set({ grams: change.grams, confirmedAt, deletedAt: null })
          .where(eq(mealRecipePortion.id, prior.id));
      else
        await tx.insert(mealRecipePortion).values({
          mealRecipeId: occurrence.id,
          mealId: targetId,
          ledgerPartyId: party.id,
          grams: change.grams,
          confirmedAt,
        });
    }
    await updatePreparationYields(tx, occurrence.id, input);

    const affectedIds = new Set([
      occurrence.mealId,
      ...existing.map((p) => p.mealId),
      ...targetIds,
    ]);
    for (const mealId of affectedIds)
      await logAuditEntry(tx, actor, {
        entityType: "meal",
        entityId: mealId,
        action: "update",
      });
    const affectedRows = await tx
      .select({ id: meal.id, shortcode: meal.shortcode })
      .from(meal)
      .where(inArray(meal.id, [...affectedIds]));
    const shortcodeById = new Map(
      affectedRows.map((row) => [row.id, row.shortcode]),
    );
    const affectedMealIds = [...affectedIds].map((id) => {
      const shortcode = shortcodeById.get(id);
      if (!shortcode)
        throw new Error("Affected meal disappeared while saving preparation");
      return parseShortcodeFor("meal", shortcode);
    });
    return saveMealRecipePreparationOut.parse({
      mealRecipeId: occurrence.id,
      estimatedYieldGrams:
        input.estimatedYieldGrams === undefined
          ? occurrence.estimatedYieldGrams
          : input.estimatedYieldGrams,
      actualYieldGrams: nextActualYield,
      affectedMealIds,
    });
  });

/**
 * One directional read: a meal is relevant if it prepared an occurrence OR
 * receives one of its portions. Source summaries and target totals then use
 * their own directions so a same-meal portion cannot be counted twice.
 */
const getMealPreparationsRaw = async (
  db: Database,
  input: GetMealPreparationsInput,
): Promise<GetMealPreparationsOut> => {
  const requestedMealId = await resolveOrThrow(db, "meal", input.mealId);
  const targetMeal = alias(meal, "MealRecipePortionTargetMeal");
  const rows = await getDb(db)
    .select({
      mealRecipeId: mealRecipe.id,
      sourceMealId: meal.id,
      sourceMealShortcode: meal.shortcode,
      sourceMealDate: meal.date,
      sourceMealName: meal.name,
      recipeShortcode: recipe.shortcode,
      recipeName: recipe.name,
      recipeYield: recipe.yield,
      recipeTotals: recipe.totals,
      totalsComputedAt: recipe.totalsComputedAt,
      scale: mealRecipe.scale,
      estimatedYieldGrams: mealRecipe.estimatedYieldGrams,
      actualYieldGrams: mealRecipe.actualYieldGrams,
      portionId: mealRecipePortion.id,
      targetMealId: targetMeal.id,
      targetMealShortcode: targetMeal.shortcode,
      targetMealDate: targetMeal.date,
      targetMealName: targetMeal.name,
      targetMealKind: targetMeal.mealKind,
      ledgerPartyId: ledgerParty.id,
      ledgerPartyShortcode: ledgerParty.shortcode,
      ledgerPartyName: ledgerParty.name,
      ledgerPartyKind: ledgerParty.kind,
      grams: mealRecipePortion.grams,
      confirmedAt: mealRecipePortion.confirmedAt,
    })
    .from(mealRecipe)
    .innerJoin(meal, and(eq(mealRecipe.mealId, meal.id), notDeleted(meal)))
    .innerJoin(
      recipe,
      and(eq(mealRecipe.recipeId, recipe.id), notDeleted(recipe)),
    )
    .leftJoin(
      mealRecipePortion,
      and(
        eq(mealRecipePortion.mealRecipeId, mealRecipe.id),
        notDeleted(mealRecipePortion),
      ),
    )
    .leftJoin(
      targetMeal,
      and(eq(mealRecipePortion.mealId, targetMeal.id), notDeleted(targetMeal)),
    )
    .leftJoin(
      ledgerParty,
      and(
        eq(mealRecipePortion.ledgerPartyId, ledgerParty.id),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        notDeleted(mealRecipe),
        or(
          eq(mealRecipe.mealId, requestedMealId),
          eq(mealRecipePortion.mealId, requestedMealId),
        ),
      ),
    );

  const preparations = new Map<
    string,
    {
      mealRecipeId: string;
      sourceMealId: string;
      sourceMeal: { id: string; date: string; name: string | null };
      recipe: { id: string; name: string };
      scale: number;
      estimatedYieldGrams: number | null;
      actualYieldGrams: number | null;
      yieldBasis: MealPreparationYieldBasis;
      totals: NutritionTotals;
      portions: PortionRow[];
    }
  >();
  for (const row of rows) {
    let preparation = preparations.get(row.mealRecipeId);
    if (!preparation) {
      const yieldBasis = yieldBasisFor(
        row.actualYieldGrams,
        row.estimatedYieldGrams,
        row.recipeYield,
        row.scale,
      );
      preparation = {
        mealRecipeId: row.mealRecipeId,
        sourceMealId: row.sourceMealId,
        sourceMeal: {
          id: parseShortcodeFor("meal", row.sourceMealShortcode),
          date: row.sourceMealDate,
          name: row.sourceMealName,
        },
        recipe: {
          id: parseShortcodeFor("recipe", row.recipeShortcode),
          name: row.recipeName,
        },
        scale: row.scale,
        estimatedYieldGrams: row.estimatedYieldGrams,
        actualYieldGrams: row.actualYieldGrams,
        yieldBasis,
        totals: batchTotalsFor(
          row.recipeTotals,
          row.totalsComputedAt,
          row.scale,
        ),
        portions: [],
      };
      preparations.set(row.mealRecipeId, preparation);
    }
    if (
      row.portionId != null &&
      row.targetMealId != null &&
      row.targetMealShortcode != null &&
      row.targetMealDate != null &&
      row.targetMealKind != null &&
      row.ledgerPartyId != null &&
      row.ledgerPartyShortcode != null &&
      row.ledgerPartyName != null &&
      row.ledgerPartyKind != null &&
      row.grams != null
    ) {
      preparation.portions.push({
        id: row.portionId,
        targetMealId: row.targetMealId,
        targetMealShortcode: row.targetMealShortcode,
        targetMealDate: row.targetMealDate,
        targetMealName: row.targetMealName,
        targetMealKind: row.targetMealKind,
        ledgerPartyId: row.ledgerPartyId,
        ledgerPartyShortcode: row.ledgerPartyShortcode,
        ledgerPartyName: row.ledgerPartyName,
        ledgerPartyKind: row.ledgerPartyKind,
        grams: row.grams,
        confirmedAt: row.confirmedAt,
      });
    }
  }

  const confirmedTotals: NutritionTotals[] = [];
  const projectedTotals: NutritionTotals[] = [];
  let confirmedCount = 0;
  let projectedCount = 0;
  const outputPreparations = [...preparations.values()].map((preparation) => {
    const preparedHere = preparation.sourceMealId === requestedMealId;
    const assignedGrams = preparation.portions.reduce(
      (sum, portion) => sum + portion.grams,
      0,
    );
    const confirmedGrams = preparation.portions
      .filter((portion) => portion.confirmedAt != null)
      .reduce((sum, portion) => sum + portion.grams, 0);
    const portions = preparation.portions.map((portion) => {
      const totals = portionTotalsFor(
        preparation.totals,
        preparation.yieldBasis,
        portion.grams,
      );
      const servedHere = portion.targetMealId === requestedMealId;
      if (servedHere) {
        projectedCount += 1;
        projectedTotals.push(totals);
        if (portion.confirmedAt != null) {
          confirmedCount += 1;
          confirmedTotals.push(totals);
        }
      }
      if (portion.ledgerPartyKind === "household")
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "The household ledger party cannot be a meal eater.",
        );
      return {
        targetMeal: {
          id: parseShortcodeFor("meal", portion.targetMealShortcode),
          date: portion.targetMealDate,
          name: portion.targetMealName,
          mealKind: portion.targetMealKind,
        },
        eater: {
          id: parseShortcodeFor("ledgerParty", portion.ledgerPartyShortcode),
          name: portion.ledgerPartyName,
          kind: portion.ledgerPartyKind,
        },
        grams: portion.grams,
        confirmedAt: portion.confirmedAt,
        servedHere,
        totals,
      };
    });
    return {
      mealRecipeId: preparation.mealRecipeId,
      preparedHere,
      sourceMeal: preparation.sourceMeal,
      recipe: preparation.recipe,
      scale: preparation.scale,
      estimatedYieldGrams: preparation.estimatedYieldGrams,
      actualYieldGrams: preparation.actualYieldGrams,
      yieldBasis: preparation.yieldBasis,
      totals: preparation.totals,
      sourceSummary: preparedHere
        ? {
            assignedGrams,
            confirmedGrams,
            unassignedGrams:
              preparation.yieldBasis.lowerGrams == null
                ? null
                : preparation.yieldBasis.lowerGrams - assignedGrams,
          }
        : null,
      portions,
    };
  });
  return getMealPreparationsOut.parse({
    mealId: input.mealId,
    preparations: outputPreparations,
    totals: {
      confirmed: {
        portionCount: confirmedCount,
        totals: aggregateTotals(confirmedTotals),
      },
      projected: {
        portionCount: projectedCount,
        totals: aggregateTotals(projectedTotals),
      },
    },
  });
};

export const getMealPreparations = async (
  db: Database,
  input: GetMealPreparationsInput,
  recipeCosting?: RecipeCostingService,
): Promise<GetMealPreparationsOut> => {
  const initial = await getMealPreparationsRaw(db, input);
  if (!recipeCosting) return initial;
  const codes = [
    ...new Set(initial.preparations.map((entry) => entry.recipe.id)),
  ];
  const resolved = await resolveAllOrThrow(
    recipeCosting.database,
    "recipe",
    codes,
  );
  const repaired = await repairStaleRecipesForRead(
    recipeCosting,
    resolved,
    "meal.getPreparations",
  );
  return repaired
    ? getMealPreparationsRaw(recipeCosting.database, input)
    : initial;
};
