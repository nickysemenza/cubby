import { getMealPreparationsOut } from "@cubby/schemas/meal";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MealPortionsSection } from "./meal-portions-section";
import type { MealPreparationsView } from "./types";

const complete = { status: "complete" as const, lower: 600, upper: 600 };
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
        estimatedYieldGrams: 500,
        actualYieldGrams: 500,
        yieldBasis: { kind: "actual", lowerGrams: 500, upperGrams: null },
        batchCalories: complete,
        batchCost: complete,
        batchProtein: complete,
        sourceSummary: {
          assignedGrams: 200,
          confirmedGrams: 0,
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
            grams: 200,
            confirmedAt: null,
            servedHere: true,
            calories: complete,
            cost: complete,
            protein: complete,
          },
        ],
      },
      {
        mealRecipeId: mealRecipeSalad,
        preparedHere: true,
        sourceMeal: { id: mealToday, date: "2026-08-31", name: "Dinner" },
        recipe: { id: recipeSalad, name: "Salad" },
        scale: 1,
        estimatedYieldGrams: 300,
        actualYieldGrams: 300,
        yieldBasis: { kind: "actual", lowerGrams: 300, upperGrams: null },
        batchCalories: complete,
        batchCost: complete,
        batchProtein: complete,
        sourceSummary: {
          assignedGrams: 150,
          confirmedGrams: 150,
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
            grams: 150,
            confirmedAt: new Date("2026-08-31T19:00:00Z"),
            servedHere: true,
            calories: complete,
            cost: complete,
            protein: complete,
          },
        ],
      },
    ],
    totals: {
      confirmed: {
        portionCount: 1,
        calories: complete,
        cost: complete,
        protein: complete,
      },
      projected: {
        portionCount: 2,
        calories: complete,
        cost: complete,
        protein: complete,
      },
    },
  });
}

describe("MealPortionsSection", () => {
  it("keeps portions grouped by recipe instead of aggregating grams across foods", () => {
    render(<MealPortionsSection view={viewWithPortions()} />);

    expect(screen.getByText("Pasta")).toBeVisible();
    expect(screen.getByText("Salad")).toBeVisible();
    expect(screen.getByText("200 g")).toBeVisible();
    expect(screen.getByText("150 g")).toBeVisible();
    expect(screen.queryByText("350 g")).not.toBeInTheDocument();
    expect(screen.getByText("Member A")).toBeVisible();
    expect(screen.getByText("Member B")).toBeVisible();
    expect(screen.getByText("Planned")).toBeVisible();
    expect(screen.getAllByText("Confirmed")).not.toHaveLength(0);
    expect(screen.getAllByText(/Cost \$600\.00/)).not.toHaveLength(0);
    expect(screen.getAllByText(/Calories 600 kcal/)).not.toHaveLength(0);
    expect(screen.getAllByText(/Protein 600 g/)).not.toHaveLength(0);
  });

  it("offers the prepared-portion flow in the no-portion state", () => {
    const onAdd = vi.fn();
    const view = viewWithPortions();
    view.preparations = view.preparations.map((preparation) => ({
      ...preparation,
      portions: [],
    }));
    render(<MealPortionsSection view={view} onAddPreparedPortion={onAdd} />);

    expect(screen.getByText("No portions logged yet")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Add prepared portion" }),
    );
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
              calories: { status: "pending", reason: "totals_missing" },
              cost: { status: "pending", reason: "totals_missing" },
              protein: { status: "pending", reason: "totals_missing" },
            },
            projected: {
              portionCount: 0,
              calories: { status: "pending", reason: "totals_missing" },
              cost: { status: "pending", reason: "totals_missing" },
              protein: { status: "pending", reason: "totals_missing" },
            },
          },
        })}
      />,
    );

    expect(screen.getByText("No prepared portions yet")).toBeVisible();
    expect(screen.getByText(/record a cooked yield/i)).toBeVisible();
  });
});
