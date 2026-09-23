import { getMealPreparationsOut } from "@cubby/schemas/meal";
import { buildNutrition, withMacros } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MealPortionsSection } from "./meal-portions-section";
import type { MealPreparationsView } from "./types";

const complete = {
  status: "complete" as const,
  lower: 600,
  upper: 600,
  coverage: { covered: 1, total: 1 },
};
const nutritionTotals = withMacros({
  cost: complete,
  nutrition: buildNutrition((key) =>
    key === "kcal" || key === "protein"
      ? complete
      : { status: "unavailable", reason: "no_data" },
  ),
});
const mealToday = testShortcode("meal", "MEL-4K7M");
const recipePasta = testShortcode("recipe", "RCP-4K7M");
const recipeSalad = testShortcode("recipe", "RCP-9Q2X");
const partyMemberA = testShortcode("ledgerParty", "LPY-4K7M");
const partyMemberB = testShortcode("ledgerParty", "LPY-9Q2X");
const mealRecipePasta = "00000000-0000-4000-8000-000000000001";
const mealRecipeSalad = "00000000-0000-4000-8000-000000000002";

function viewWithPortions(): MealPreparationsView {
  return getMealPreparationsOut.parse({
    mealId: mealToday,
    preparations: [
      {
        mealRecipeId: mealRecipePasta,
        preparedHere: true,
        sourceMeal: { id: mealToday, date: "2026-08-31", name: "Dinner" },
        recipe: { id: recipePasta, name: "Pasta" },
        scale: 1,
        recipeServings: 4,
        recipeYield: { value: 500, unit: "g" },
        estimatedYieldGrams: 500,
        actualYieldGrams: 500,
        yieldBasis: { kind: "actual", lowerGrams: 500, upperGrams: null },
        totals: nutritionTotals,
        sourceSummary: {
          assignedGrams: 200,
          confirmedGrams: 0,
          assignedShare: { ...complete, lower: 0.4, upper: null },
          unassignedGrams: 300,
        },
        portions: [
          {
            targetMeal: {
              id: mealToday,
              date: "2026-08-31",
              name: "Dinner",
              mealKind: "cooked",
            },
            eater: { id: partyMemberA, name: "Member A", kind: "member" },
            amount: { value: 1, unit: "serving" },
            grams: 200,
            weight: { ...complete, lower: 200, upper: null },
            batchShare: { ...complete, lower: 0.4, upper: null },
            confirmedAt: null,
            servedHere: true,
            totals: nutritionTotals,
          },
        ],
      },
      {
        mealRecipeId: mealRecipeSalad,
        preparedHere: true,
        sourceMeal: { id: mealToday, date: "2026-08-31", name: "Dinner" },
        recipe: { id: recipeSalad, name: "Salad" },
        scale: 1,
        recipeServings: null,
        recipeYield: { value: 300, unit: "g" },
        estimatedYieldGrams: 300,
        actualYieldGrams: 300,
        yieldBasis: { kind: "actual", lowerGrams: 300, upperGrams: null },
        totals: nutritionTotals,
        sourceSummary: {
          assignedGrams: 150,
          confirmedGrams: 150,
          assignedShare: { ...complete, lower: 0.5, upper: null },
          unassignedGrams: 150,
        },
        portions: [
          {
            targetMeal: {
              id: mealToday,
              date: "2026-08-31",
              name: "Dinner",
              mealKind: "cooked",
            },
            eater: { id: partyMemberB, name: "Member B", kind: "member" },
            amount: { value: 1, unit: "bowl" },
            grams: null,
            weight: { status: "unavailable", reason: "no_data" },
            batchShare: { status: "unavailable", reason: "no_data" },
            confirmedAt: new Date("2026-08-31T19:00:00Z"),
            servedHere: true,
            totals: nutritionTotals,
          },
        ],
      },
    ],
    totals: {
      confirmed: {
        portionCount: 1,
        totals: nutritionTotals,
      },
      projected: {
        portionCount: 2,
        totals: nutritionTotals,
      },
    },
  });
}

describe("MealPortionsSection", () => {
  it("keeps portions grouped by recipe instead of aggregating grams across foods", () => {
    render(<MealPortionsSection view={viewWithPortions()} />);

    expect(screen.getByText("Pasta")).toBeVisible();
    expect(screen.getByText("Salad")).toBeVisible();
    // The eater name is its own <span> inside the row, so match on the row.
    expect(
      screen
        .getByText("Member A")
        .closest("li")
        ?.textContent?.replace(/\s+/g, " "),
    ).toMatch(/Member A 1 serving/);
    expect(
      screen
        .getByText("Member B")
        .closest("li")
        ?.textContent?.replace(/\s+/g, " "),
    ).toMatch(/Member B 1 bowl/);
    expect(screen.getByText(/Current conversion unavailable/)).toBeVisible();
    expect(screen.queryByText("350 g")).not.toBeInTheDocument();
    expect(screen.queryByText("Planned")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirmed")).not.toBeInTheDocument();
    expect(screen.getByText("500 g made")).toBeVisible();
  });

  it("keeps an unassigned preparation visible and offers leftovers", () => {
    const onAdd = vi.fn();
    const view = viewWithPortions();
    view.preparations = view.preparations.map((preparation) => ({
      ...preparation,
      portions: [],
    }));
    render(<MealPortionsSection view={view} onAddPreparedPortion={onAdd} />);

    expect(screen.getAllByText("No one assigned yet")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Add leftovers" }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("makes a leftovers-only meal complete without asking for a recipe", () => {
    const onAdd = vi.fn();
    render(
      <MealPortionsSection
        onAddPreparedPortion={onAdd}
        view={getMealPreparationsOut.parse({
          mealId: mealToday,
          preparations: [],
          totals: {
            confirmed: {
              portionCount: 0,
              totals: withMacros({
                cost: { status: "unavailable", reason: "empty" },
                nutrition: buildNutrition(() => ({
                  status: "unavailable",
                  reason: "empty",
                })),
              }),
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
        })}
      />,
    );

    expect(screen.getByText("No recipe portions yet")).toBeVisible();
    expect(
      screen.getByText(/add a recipe or bring in leftovers/i),
    ).toBeVisible();
  });
});
