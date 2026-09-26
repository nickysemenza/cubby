import { describe, expect, it } from "vitest";
import { testShortcode } from "./test-support/identifiers";
import {
  getMealPreparationsOut,
  mealPreparationYieldBasis,
  saveMealRecipePreparationInput,
  saveMealRecipePreparationOut,
} from "./meal";
import { buildNutrition, measureEstimate, withMacros } from "./nutrition";

const mealId = testShortcode("meal", "meal-preparation");
const leftoversMealId = testShortcode("meal", "leftovers");
const recipeId = testShortcode("recipe", "meal-preparation");
const eaterId = testShortcode("ledgerParty", "meal-preparation");
const mealRecipeId = "00000000-0000-4000-8000-000000000001";
const complete = (lower: number) => ({
  status: "complete" as const,
  lower,
  upper: null,
  coverage: { covered: 1, total: 1 },
});
const totals = (cost: number, kcal: number, protein: number) =>
  withMacros({
    cost: complete(cost),
    nutrition: buildNutrition((key) =>
      key === "kcal"
        ? complete(kcal)
        : key === "protein"
          ? complete(protein)
          : { status: "unavailable", reason: "no_data" },
    ),
  });

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
            amount: { value: 200, unit: "g" },
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

  it("allows clearing either yield but rejects non-positive or fractional yield grams", () => {
    expect(
      saveMealRecipePreparationInput.safeParse({
        mealRecipeId,
        actualYieldGrams: null,
        changes: [],
      }).success,
    ).toBe(true);

    // estimatedYieldGrams/actualYieldGrams stay `mealYieldGrams` (int, positive):
    // an authored yield is always a whole gram count.
    for (const grams of [0, -1, 1.5]) {
      expect(
        saveMealRecipePreparationInput.safeParse({
          mealRecipeId,
          actualYieldGrams: grams,
          changes: [],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects non-positive change amounts but allows fractional amounts (#1058 generic meal amounts)", () => {
    for (const value of [0, -1]) {
      expect(
        saveMealRecipePreparationInput.safeParse({
          mealRecipeId,
          changes: [
            {
              action: "set",
              mealId,
              ledgerPartyId: eaterId,
              amount: { value, unit: "g" },
              confirmed: false,
            },
          ],
        }).success,
      ).toBe(false);
    }

    // Unlike the authored yields above, a change's `amount.value` is
    // `finite().positive()` (no int()), so a fractional portion is valid.
    expect(
      saveMealRecipePreparationInput.safeParse({
        mealRecipeId,
        changes: [
          {
            action: "set",
            mealId,
            ledgerPartyId: eaterId,
            amount: { value: 1.5, unit: "g" },
            confirmed: false,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a set change with no amount", () => {
    expect(
      saveMealRecipePreparationInput.safeParse({
        mealRecipeId,
        changes: [
          {
            action: "set",
            mealId,
            ledgerPartyId: eaterId,
            confirmed: false,
          },
        ],
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
            amount: { value: 200, unit: "g" },
            confirmed: false,
          },
        ],
      }).success,
    ).toBe(true);
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
            amount: { value: 150, unit: "g" },
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

  it("models estimate completeness and yield provenance as closed unions", () => {
    expect(
      measureEstimate.parse({
        status: "pending",
        reason: "totals_stale",
      }),
    ).toEqual({ status: "pending", reason: "totals_stale" });
    expect(
      measureEstimate.parse({
        status: "complete",
        lower: 350,
        upper: null,
        coverage: { covered: 1, total: 1 },
      }),
    ).toEqual({
      status: "complete",
      lower: 350,
      upper: null,
      coverage: { covered: 1, total: 1 },
    });
    expect(
      measureEstimate.safeParse({
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
          recipeServings: 4,
          recipeYield: { value: 520, unit: "g" },
          estimatedYieldGrams: 520,
          actualYieldGrams: 500,
          yieldBasis: {
            kind: "actual",
            lowerGrams: 500,
            upperGrams: null,
          },
          totals: totals(10, 1000, 80),
          sourceSummary: {
            assignedGrams: 350,
            confirmedGrams: 200,
            assignedShare: complete(0.7),
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
              amount: { value: 200, unit: "g" },
              grams: 200,
              weight: complete(200),
              batchShare: complete(0.4),
              confirmedAt: new Date("2026-08-31T19:00:00Z"),
              servedHere: true,
              totals: totals(4, 400, 32),
            },
          ],
        },
      ],
      totals: {
        confirmed: {
          portionCount: 1,
          totals: totals(4, 400, 32),
        },
        projected: {
          portionCount: 0,
          totals: withMacros({
            cost: { status: "unavailable", reason: "empty" },
            nutrition: buildNutrition(() => ({
              status: "unavailable",
              reason: "empty",
            })),
          }),
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
