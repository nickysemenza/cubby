import type { ActorContext } from "@cubby/schemas/context";
import {
  type MealRecipeId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  type GetMealPreparationsInput,
  type GetMealPreparationsOut,
  getMealPreparationsOut,
  type MealPreparationCalorieEstimate,
  type MealPreparationEstimate,
  type MealPreparationYieldBasis,
  type SaveMealRecipePreparationInput,
  type SaveMealRecipePreparationOut,
  saveMealRecipePreparationOut,
} from "@cubby/schemas/meal";
import type { MealKind } from "@cubby/schemas/meal-classification";
import type { RecipeTotals, RecipeYield } from "@cubby/schemas/recipe-shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

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

type PortionMeasure = "cost" | "calories" | "protein";

type PortionMeasureDefinition = {
  uncoveredReason: Extract<
    MealPreparationEstimate,
    { status: "unavailable" }
  >["reason"];
  lower: (totals: RecipeTotals) => number | undefined;
  upper: (totals: RecipeTotals) => number | undefined;
  covered: (totals: RecipeTotals) => number | undefined;
};

const portionMeasures = {
  cost: {
    uncoveredReason: "cost_uncovered",
    lower: (totals) => totals.costTotal,
    upper: (totals) => totals.costTotalUpper,
    covered: (totals) => totals.costCovered,
  },
  calories: {
    uncoveredReason: "calories_uncovered",
    lower: (totals) => totals.caloriesTotal,
    upper: (totals) => totals.caloriesTotalUpper,
    covered: (totals) => totals.caloriesCovered,
  },
  protein: {
    uncoveredReason: "protein_uncovered",
    lower: (totals) => totals.proteinTotal,
    upper: (totals) => totals.proteinTotalUpper,
    covered: (totals) => totals.proteinCovered,
  },
} satisfies Record<PortionMeasure, PortionMeasureDefinition>;

/** One scaling/coverage pipeline for every measure carried by a portion. */
export const batchEstimateFor = (
  totals: RecipeTotals | null,
  totalsComputedAt: Date | null,
  scale: number,
  measure: PortionMeasure,
): MealPreparationEstimate => {
  if (!totals) return { status: "pending", reason: "totals_missing" };
  if (!totalsComputedAt) return { status: "pending", reason: "totals_stale" };
  const definition = portionMeasures[measure];
  const covered = definition.covered(totals);
  const lower = definition.lower(totals);
  const upper = definition.upper(totals);
  // Nutrient coverage was added after recipe totals already existed. The
  // totals service normally marks those rows stale; retaining this defensive
  // branch means an older row can never silently report protein as zero.
  if (covered == null && measure === "protein")
    return { status: "pending", reason: "totals_stale" };
  if (
    covered == null ||
    lower == null ||
    (covered === 0 && totals.ingredientCount > 0)
  )
    return { status: "unavailable", reason: definition.uncoveredReason };
  if (covered < totals.ingredientCount)
    return { status: "partial", lower: lower * scale };
  return {
    status: "complete",
    lower: lower * scale,
    upper: upper == null ? null : upper * scale,
  };
};

// Existing calorie-specific exports remain as compatibility helpers for callers
// outside the portion view. New code should call the measure-generic helpers.
export const batchCaloriesFor = (
  totals: RecipeTotals | null,
  totalsComputedAt: Date | null,
  scale: number,
): MealPreparationCalorieEstimate =>
  batchEstimateFor(totals, totalsComputedAt, scale, "calories");

export const portionEstimateFor = (
  batch: MealPreparationEstimate,
  yieldBasis: MealPreparationYieldBasis,
  grams: number,
): MealPreparationEstimate => {
  if (yieldBasis.kind === "missing")
    return { status: "unavailable", reason: "yield_missing" };
  if (batch.status === "pending" || batch.status === "unavailable")
    return batch;
  const upperYield = yieldBasis.upperGrams ?? yieldBasis.lowerGrams;
  if (batch.status === "partial")
    return { status: "partial", lower: (batch.lower * grams) / upperYield };
  return {
    status: "complete",
    lower: (batch.lower * grams) / upperYield,
    upper:
      batch.upper == null
        ? yieldBasis.upperGrams == null
          ? null
          : (batch.lower * grams) / yieldBasis.lowerGrams
        : (batch.upper * grams) / yieldBasis.lowerGrams,
  };
};

export const aggregateMealPreparationEstimates = (
  entries: MealPreparationEstimate[],
): MealPreparationEstimate => {
  if (entries.length === 0)
    return { status: "complete", lower: 0, upper: null };
  const missing = entries.find(
    (entry) => entry.status === "pending" && entry.reason === "totals_missing",
  );
  if (missing) return missing;
  const stale = entries.find((entry) => entry.status === "pending");
  if (stale) return stale;
  const covered = entries.filter(hasKnownEstimate);
  if (covered.length === 0) {
    const yieldMissing = entries.find(
      (entry) =>
        entry.status === "unavailable" && entry.reason === "yield_missing",
    );
    return (
      yieldMissing ?? entries.find((entry) => entry.status === "unavailable")!
    );
  }
  if (
    covered.length !== entries.length ||
    covered.some((entry) => entry.status === "partial")
  )
    return {
      status: "partial",
      lower: covered.reduce((sum, entry) => sum + entry.lower, 0),
    };
  const complete = covered.filter(hasCompleteEstimate);
  return {
    status: "complete",
    lower: complete.reduce((sum, entry) => sum + entry.lower, 0),
    upper: complete.some((entry) => entry.upper != null)
      ? complete.reduce((sum, entry) => sum + (entry.upper ?? entry.lower), 0)
      : null,
  };
};

export const aggregateMealPreparationCalories = (
  entries: MealPreparationCalorieEstimate[],
): MealPreparationCalorieEstimate => aggregateMealPreparationEstimates(entries);

type KnownEstimate = Extract<
  MealPreparationEstimate,
  { status: "partial" | "complete" }
>;
type CompleteEstimate = Extract<
  MealPreparationEstimate,
  { status: "complete" }
>;

const hasKnownEstimate = (
  entry: MealPreparationEstimate,
): entry is KnownEstimate =>
  entry.status === "partial" || entry.status === "complete";

const hasCompleteEstimate = (entry: KnownEstimate): entry is CompleteEstimate =>
  entry.status === "complete";

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
export const getMealPreparations = async (
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
      batchCalories: MealPreparationCalorieEstimate;
      batchCost: MealPreparationEstimate;
      batchProtein: MealPreparationEstimate;
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
        batchCalories: batchCaloriesFor(
          row.recipeTotals,
          row.totalsComputedAt,
          row.scale,
        ),
        batchCost: batchEstimateFor(
          row.recipeTotals,
          row.totalsComputedAt,
          row.scale,
          "cost",
        ),
        batchProtein: batchEstimateFor(
          row.recipeTotals,
          row.totalsComputedAt,
          row.scale,
          "protein",
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

  const confirmedCalories: MealPreparationCalorieEstimate[] = [];
  const projectedCalories: MealPreparationCalorieEstimate[] = [];
  const confirmedCost: MealPreparationEstimate[] = [];
  const projectedCost: MealPreparationEstimate[] = [];
  const confirmedProtein: MealPreparationEstimate[] = [];
  const projectedProtein: MealPreparationEstimate[] = [];
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
      const calories = portionEstimateFor(
        preparation.batchCalories,
        preparation.yieldBasis,
        portion.grams,
      );
      const cost = portionEstimateFor(
        preparation.batchCost,
        preparation.yieldBasis,
        portion.grams,
      );
      const protein = portionEstimateFor(
        preparation.batchProtein,
        preparation.yieldBasis,
        portion.grams,
      );
      const servedHere = portion.targetMealId === requestedMealId;
      if (servedHere) {
        projectedCount += 1;
        projectedCalories.push(calories);
        projectedCost.push(cost);
        projectedProtein.push(protein);
        if (portion.confirmedAt != null) {
          confirmedCount += 1;
          confirmedCalories.push(calories);
          confirmedCost.push(cost);
          confirmedProtein.push(protein);
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
        calories,
        cost,
        protein,
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
      batchCalories: preparation.batchCalories,
      batchCost: preparation.batchCost,
      batchProtein: preparation.batchProtein,
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
        calories: aggregateMealPreparationCalories(confirmedCalories),
        cost: aggregateMealPreparationEstimates(confirmedCost),
        protein: aggregateMealPreparationEstimates(confirmedProtein),
      },
      projected: {
        portionCount: projectedCount,
        calories: aggregateMealPreparationCalories(projectedCalories),
        cost: aggregateMealPreparationEstimates(projectedCost),
        protein: aggregateMealPreparationEstimates(projectedProtein),
      },
    },
  });
};
