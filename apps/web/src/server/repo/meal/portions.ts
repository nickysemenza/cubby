import type { ActorContext } from "@cubby/schemas/context";
import {
  type MealRecipeId,
  parseShortcodeFor,
  type RecipeId,
} from "@cubby/schemas/identifiers";
import {
  type GetMealPreparationsInput,
  type MealFoodAmount,
  type GetMealPreparationsOut,
  getMealPreparationsOut,
  type MealPreparationYieldBasis,
  type SaveMealRecipePreparationInput,
  type SaveMealRecipePreparationOut,
  saveMealRecipePreparationOut,
} from "@cubby/schemas/meal";
import type { MealKind } from "@cubby/schemas/meal-classification";
import { type NutritionTotals } from "@cubby/schemas/nutrition";
import type {
  RecipeYield,
  StoredRecipeTotals,
} from "@cubby/schemas/recipe-shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { calculateFoodAmount } from "~/lib/meal-food-nutrition";
import {
  aggregateTotals,
  aggregateEstimates,
  pendingTotals,
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
  amount: MealFoodAmount;
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
  totals: StoredRecipeTotals | null,
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
): NutritionTotals =>
  calculateFoodAmount(
    { value: grams, unit: "g" },
    {
      kind: "recipe",
      batch,
      yieldBasis,
      recipeYield: null,
      servings: null,
      scale: 1,
    },
  ).totals;

/**
 * Resolve the yield basis for a preparation's changes and confirm the
 * definite shares they assign do not exceed the actual cooked yield (or the
 * whole batch, when yield is only estimated or missing). Estimated cooked
 * weight is advisory, not evidence of over-allocation, so weight-only amounts
 * are excluded from the check while yield is unknown.
 */
const resolveYieldBasisAndValidateShares = async (
  tx: DrizzleTransaction,
  occurrence: {
    recipeId: RecipeId;
    scale: number;
    estimatedYieldGrams: number | null;
    actualYieldGrams: number | null;
  },
  input: SaveMealRecipePreparationInput,
  finalAmounts: Map<string, MealFoodAmount | null>,
): Promise<{
  basis: MealPreparationYieldBasis;
  nextActualYield: number | null;
}> => {
  const nextActualYield =
    input.actualYieldGrams === undefined
      ? occurrence.actualYieldGrams
      : input.actualYieldGrams;
  const [sourceRecipe] = await tx
    .select({
      servings: recipe.servings,
      yield: recipe.yield,
      totals: recipe.totals,
      totalsComputedAt: recipe.totalsComputedAt,
    })
    .from(recipe)
    .where(and(eq(recipe.id, occurrence.recipeId), notDeleted(recipe)));
  if (!sourceRecipe)
    throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
  const basis = yieldBasisFor(
    nextActualYield,
    input.estimatedYieldGrams === undefined
      ? occurrence.estimatedYieldGrams
      : input.estimatedYieldGrams,
    sourceRecipe.yield,
    occurrence.scale,
  );
  const definiteShares = [...finalAmounts.values()].map((amount) => {
    // Estimated cooked weight is advisory, not evidence of over-allocation.
    if (
      !amount ||
      (nextActualYield == null &&
        safeConvertAmount(amount, [], "weight").isOk())
    )
      return 0;
    const share = calculateFoodAmount(amount, {
      kind: "recipe",
      batch: batchTotalsFor(
        sourceRecipe.totals,
        sourceRecipe.totalsComputedAt,
        occurrence.scale,
      ),
      yieldBasis: basis,
      recipeYield: sourceRecipe.yield,
      servings: sourceRecipe.servings,
      scale: occurrence.scale,
    }).batchShare;
    return share.status === "complete" || share.status === "partial"
      ? share.lower
      : 0;
  });
  if (definiteShares.reduce((sum, share) => sum + share, 0) > 1 + 1e-9)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Assigned portions exceed the actual cooked yield or the whole batch.",
    );
  return { basis, nextActualYield };
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
        recipeId: mealRecipe.recipeId,
        scale: mealRecipe.scale,
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
        recipeId: mealRecipe.recipeId,
        scale: mealRecipe.scale,
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
        amount: mealRecipePortion.amount,
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
    const finalAmounts = new Map(
      existing.map((portion) => [
        `${portion.mealId}:${portion.ledgerPartyId}`,
        portion.amount,
      ]),
    );
    for (const [index, change] of input.changes.entries()) {
      const targetId = targetIds[index]!;
      const party = parties[index]!;
      const key = `${targetId}:${party.id}`;
      if (change.action === "remove") finalAmounts.delete(key);
      else finalAmounts.set(key, change.amount);
    }
    const { nextActualYield } = await resolveYieldBasisAndValidateShares(
      tx,
      occurrence,
      input,
      finalAmounts,
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
      // saved. A later amount correction must not rewrite when it was consumed.
      const confirmedAt = change.confirmed ? (prior?.confirmedAt ?? now) : null;
      if (prior)
        await tx
          .update(mealRecipePortion)
          .set({
            amount: change.amount,
            confirmedAt,
            deletedAt: null,
          })
          .where(eq(mealRecipePortion.id, prior.id));
      else
        await tx.insert(mealRecipePortion).values({
          mealRecipeId: occurrence.id,
          mealId: targetId,
          ledgerPartyId: party.id,
          amount: change.amount,
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
      recipeServings: recipe.servings,
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
      amount: mealRecipePortion.amount,
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
      recipeYield: RecipeYield | null;
      recipeServings: number | null;
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
        recipeYield: row.recipeYield,
        recipeServings: row.recipeServings,
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
      row.amount != null
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
        amount: row.amount,
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
    const calculated = preparation.portions.map((portion) => ({
      portion,
      result: calculateFoodAmount(portion.amount, {
        kind: "recipe",
        batch: preparation.totals,
        yieldBasis: preparation.yieldBasis,
        recipeYield: preparation.recipeYield,
        servings: preparation.recipeServings,
        scale: preparation.scale,
      }),
    }));
    const sumGrams = (entries: typeof calculated) =>
      entries.some(({ result }) => result.grams == null)
        ? null
        : entries.reduce((sum, { result }) => sum + (result.grams ?? 0), 0);
    const assignedGrams = sumGrams(calculated);
    const confirmedGrams = sumGrams(
      calculated.filter(({ portion }) => portion.confirmedAt != null),
    );
    const assignedShare = aggregateEstimates(
      calculated.map(({ result }) => result.batchShare),
    );
    const portions = calculated.map(({ portion, result }) => {
      const { totals } = result;
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
        amount: portion.amount,
        grams: result.grams,
        weight: result.weight,
        batchShare: result.batchShare,
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
      recipeYield: preparation.recipeYield,
      recipeServings: preparation.recipeServings,
      totals: preparation.totals,
      sourceSummary: preparedHere
        ? {
            assignedGrams,
            confirmedGrams,
            assignedShare,
            unassignedGrams:
              preparation.yieldBasis.lowerGrams == null ||
              assignedGrams == null ||
              preparation.yieldBasis.upperGrams != null
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
