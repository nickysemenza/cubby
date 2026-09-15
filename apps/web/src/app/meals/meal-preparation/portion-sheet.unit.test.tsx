import {
  getMealPreparationsOut,
  saveMealRecipePreparationOut,
} from "@cubby/schemas/meal";
import { buildNutrition } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { useMutation } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { meal } from "../meal.functions";
import { PortionSheet } from "./portion-sheet";

const complete = (lower: number) => ({
  status: "complete" as const,
  lower,
  upper: null,
  coverage: { covered: 1, total: 1 },
});
const nutritionTotals = (cost: number, kcal: number, protein: number) => ({
  cost: complete(cost),
  nutrition: buildNutrition((key) =>
    key === "kcal"
      ? complete(kcal)
      : key === "protein"
        ? complete(protein)
        : { status: "unavailable", reason: "no_data" },
  ),
});

const view = getMealPreparationsOut.parse({
  mealId: testShortcode("meal", "MEL-4K7M"),
  preparations: [
    {
      mealRecipeId: "00000000-0000-4000-8000-000000000001",
      preparedHere: true,
      sourceMeal: {
        id: testShortcode("meal", "MEL-4K7M"),
        date: "2026-08-31",
        name: "Dinner",
      },
      recipe: { id: testShortcode("recipe", "RCP-4K7M"), name: "Pasta" },
      scale: 1,
      estimatedYieldGrams: 600,
      actualYieldGrams: 500,
      yieldBasis: { kind: "actual", lowerGrams: 500, upperGrams: 500 },
      totals: nutritionTotals(10, 1000, 80),
      sourceSummary: {
        assignedGrams: 350,
        confirmedGrams: 200,
        unassignedGrams: 150,
      },
      portions: [
        {
          targetMeal: {
            id: testShortcode("meal", "MEL-4K7M"),
            date: "2026-08-31",
            name: "Dinner",
            mealKind: "cooked",
          },
          eater: {
            id: testShortcode("ledgerParty", "LPY-4K7M"),
            name: "Member A",
            kind: "member",
          },
          grams: 200,
          confirmedAt: new Date("2026-08-31T19:00:00Z"),
          servedHere: true,
          totals: nutritionTotals(4, 400, 32),
        },
      ],
    },
  ],
  totals: {
    confirmed: {
      portionCount: 1,
      totals: nutritionTotals(4, 400, 32),
    },
    projected: {
      portionCount: 1,
      totals: nutritionTotals(4, 400, 32),
    },
  },
});

const source = view.preparations[0]!;
const targetMeals = [source.portions[0]!.targetMeal];
const eaters = [source.portions[0]!.eater];

describe("PortionSheet", () => {
  it("sends its rendered save through the meal preparation operation contract", async () => {
    const requests: unknown[] = [];
    const saveOperation = meal.savePreparation.withTransport(
      async ({ input }) => {
        requests.push(input);
        return saveMealRecipePreparationOut.parse({
          mealRecipeId: source.mealRecipeId,
          estimatedYieldGrams: source.estimatedYieldGrams,
          actualYieldGrams: source.actualYieldGrams,
          affectedMealIds: [source.sourceMeal.id],
        });
      },
    );
    const harness = createBrowserTestHarness();

    function OperationBackedSheet() {
      const save = useMutation(saveOperation.mutationOptions());
      return (
        <PortionSheet
          source={source}
          currentMealId={source.sourceMeal.id}
          targetMeals={targetMeals}
          eaters={eaters}
          open
          onOpenChange={vi.fn()}
          onSave={(request) => save.mutate(request)}
        />
      );
    }

    try {
      render(<OperationBackedSheet />, { wrapper: harness.wrapper });
      fireEvent.click(screen.getByRole("button", { name: "Save portions" }));
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toMatchObject({
        mealRecipeId: source.mealRecipeId,
        estimatedYieldGrams: 600,
        actualYieldGrams: 500,
        changes: [],
      });
    } finally {
      harness.dispose();
    }
  });

  it("emits a remove command when the last persisted portion is removed", () => {
    const onSave = vi.fn();
    render(
      <PortionSheet
        source={source}
        currentMealId={source.sourceMeal.id}
        targetMeals={targetMeals}
        eaters={eaters}
        open
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove person 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save portions" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        mealRecipeId: source.mealRecipeId,
        estimatedYieldGrams: 600,
        actualYieldGrams: 500,
        changes: [
          {
            action: "remove",
            mealId: source.portions[0]!.targetMeal.id,
            ledgerPartyId: source.portions[0]!.eater.id,
          },
        ],
      }),
    );
  });

  it("saves only an edited portion and records it directly", () => {
    const onSave = vi.fn();
    render(
      <PortionSheet
        source={{
          ...source,
          portions: [{ ...source.portions[0]!, confirmedAt: null }],
        }}
        currentMealId={source.sourceMeal.id}
        targetMeals={targetMeals}
        eaters={eaters}
        open
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: /confirmed/i }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Grams"), {
      target: { value: "225" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save portions" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          {
            action: "set",
            mealId: source.sourceMeal.id,
            ledgerPartyId: source.portions[0]!.eater.id,
            grams: 225,
            confirmed: true,
          },
        ],
      }),
    );
  });

  it("offers serving shortcuts when the recipe has an exact gram yield", () => {
    render(
      <PortionSheet
        source={source}
        currentMealId={source.sourceMeal.id}
        recipeServings={4}
        targetMeals={targetMeals}
        eaters={eaters}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("1 serving ≈ 125 g")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "1.5×" }));
    expect(screen.getByLabelText("Grams")).toHaveValue(188);
  });

  it("scales the serving count with a scaled recipe occurrence", () => {
    render(
      <PortionSheet
        source={{
          ...source,
          scale: 2,
          actualYieldGrams: 1000,
          yieldBasis: { kind: "actual", lowerGrams: 1000, upperGrams: 1000 },
        }}
        currentMealId={source.sourceMeal.id}
        recipeServings={4}
        targetMeals={targetMeals}
        eaters={eaters}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("1 serving ≈ 125 g")).toBeVisible();
  });

  it("requires integer gram measurements before saving", () => {
    const onSave = vi.fn();
    render(
      <PortionSheet
        source={{ ...source, portions: [] }}
        currentMealId={source.sourceMeal.id}
        targetMeals={targetMeals}
        eaters={eaters}
        open
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText("Grams"), {
      target: { value: "200.5" },
    });
    expect(
      screen.getByRole("button", { name: "Save portions" }),
    ).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("adopts default meal and eater options that finish loading after the sheet", async () => {
    const onSave = vi.fn();
    const emptySource = { ...source, portions: [] };
    const { rerender } = render(
      <PortionSheet
        source={emptySource}
        currentMealId={source.sourceMeal.id}
        targetMeals={[]}
        eaters={[]}
        open
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );

    rerender(
      <PortionSheet
        source={emptySource}
        currentMealId={source.sourceMeal.id}
        targetMeals={targetMeals}
        eaters={eaters}
        open
        onOpenChange={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText("Grams"), {
      target: { value: "200" },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save portions" }),
      ).toBeEnabled(),
    );
  });
});
