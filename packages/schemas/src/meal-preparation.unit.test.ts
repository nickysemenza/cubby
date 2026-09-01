import { describe, expect, it } from "vitest";
import { testShortcode } from "./test-support/identifiers";
import {
  getMealPreparationsOut,
  mealPreparationEstimate,
  mealPreparationYieldBasis,
  saveMealRecipePreparationInput,
  saveMealRecipePreparationOut,
} from "./meal";

const mealId = testShortcode("meal", "meal-preparation");
const leftoversMealId = testShortcode("meal", "leftovers");
const recipeId = testShortcode("recipe", "meal-preparation");
const eaterId = testShortcode("ledgerParty", "meal-preparation");
const mealRecipeId = "00000000-0000-4000-8000-000000000001";

describe("meal preparation contracts", () => {
  it("accepts positive integer yields and keyed set/remove portion changes", () => {
    expect(
      saveMealRecipePreparationInput.parse({
        mealRecipeId,
        estimatedYieldGrams: 520,
        actualYieldGrams: 500,
        changes: [
          {
            action: "set",
            mealId,
            ledgerPartyId: eaterId,
            grams: 200,
            confirmed: true,
          },
          {
            action: "remove",
            mealId: leftoversMealId,
            ledgerPartyId: eaterId,
          },
        ],
      }),
    ).toMatchObject({
      estimatedYieldGrams: 520,
      actualYieldGrams: 500,
      changes: [{ action: "set", confirmed: true }, { action: "remove" }],
    });
  });

  it("allows clearing either yield but rejects non-positive or fractional grams", () => {
    expect(
      saveMealRecipePreparationInput.safeParse({
        mealRecipeId,
        actualYieldGrams: null,
        changes: [],
      }).success,
    ).toBe(true);

    for (const grams of [0, -1, 1.5]) {
      expect(
        saveMealRecipePreparationInput.safeParse({
          mealRecipeId,
          actualYieldGrams: grams,
          changes: [],
        }).success,
      ).toBe(false);
      expect(
        saveMealRecipePreparationInput.safeParse({
          mealRecipeId,
          changes: [
            {
              action: "set",
              mealId,
              ledgerPartyId: eaterId,
              grams,
              confirmed: false,
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects ambiguous duplicate changes for the same target meal and eater", () => {
    expect(
      saveMealRecipePreparationInput.safeParse({
        mealRecipeId,
        changes: [
          {
            action: "set",
            mealId,
            ledgerPartyId: eaterId,
            grams: 150,
            confirmed: false,
          },
          {
            action: "remove",
            mealId,
            ledgerPartyId: eaterId,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("models calorie completeness and yield provenance as closed unions", () => {
    expect(
      mealPreparationEstimate.parse({
        status: "pending",
        reason: "totals_stale",
      }),
    ).toEqual({ status: "pending", reason: "totals_stale" });
    expect(
      mealPreparationEstimate.parse({
        status: "complete",
        lower: 350,
        upper: null,
      }),
    ).toEqual({ status: "complete", lower: 350, upper: null });
    expect(
      mealPreparationEstimate.safeParse({
        status: "unavailable",
        reason: "totals_missing",
      }).success,
    ).toBe(false);

    expect(
      mealPreparationYieldBasis.parse({
        kind: "actual",
        lowerGrams: 500,
        upperGrams: null,
      }),
    ).toEqual({ kind: "actual", lowerGrams: 500, upperGrams: null });
    expect(
      mealPreparationYieldBasis.parse({
        kind: "missing",
        lowerGrams: null,
        upperGrams: null,
      }),
    ).toEqual({ kind: "missing", lowerGrams: null, upperGrams: null });
  });

  it("groups source preparations, target portions, and target-meal totals without exposing portion UUIDs", () => {
    const parsed = getMealPreparationsOut.parse({
      mealId,
      preparations: [
        {
          mealRecipeId,
          preparedHere: true,
          sourceMeal: {
            id: mealId,
            date: "2026-08-31",
            name: "Dinner",
          },
          recipe: { id: recipeId, name: "Soup" },
          scale: 1,
          estimatedYieldGrams: 520,
          actualYieldGrams: 500,
          yieldBasis: {
            kind: "actual",
            lowerGrams: 500,
            upperGrams: null,
          },
          batchCalories: { status: "complete", lower: 1000, upper: null },
          batchCost: { status: "complete", lower: 10, upper: null },
          batchProtein: { status: "complete", lower: 80, upper: null },
          sourceSummary: {
            assignedGrams: 350,
            confirmedGrams: 200,
            unassignedGrams: 150,
          },
          portions: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              targetMeal: {
                id: mealId,
                date: "2026-08-31",
                name: "Dinner",
                mealKind: "cooked",
              },
              eater: { id: eaterId, name: "Household member", kind: "member" },
              grams: 200,
              confirmedAt: new Date("2026-08-31T19:00:00Z"),
              servedHere: true,
              calories: { status: "complete", lower: 400, upper: null },
              cost: { status: "complete", lower: 4, upper: null },
              protein: { status: "complete", lower: 32, upper: null },
            },
          ],
        },
      ],
      totals: {
        confirmed: {
          portionCount: 1,
          calories: { status: "complete", lower: 400, upper: null },
          cost: { status: "complete", lower: 4, upper: null },
          protein: { status: "complete", lower: 32, upper: null },
        },
        projected: {
          portionCount: 0,
          calories: { status: "complete", lower: 0, upper: null },
          cost: { status: "complete", lower: 0, upper: null },
          protein: { status: "complete", lower: 0, upper: null },
        },
      },
    });

    expect(parsed.preparations[0]?.portions[0]).not.toHaveProperty("id");
  });

  it("keeps save results minimal and refetch-oriented", () => {
    expect(
      saveMealRecipePreparationOut.parse({
        mealRecipeId,
        estimatedYieldGrams: 520,
        actualYieldGrams: 500,
        affectedMealIds: [mealId, leftoversMealId],
      }),
    ).toMatchObject({
      mealRecipeId,
      affectedMealIds: [mealId, leftoversMealId],
    });
  });
});
