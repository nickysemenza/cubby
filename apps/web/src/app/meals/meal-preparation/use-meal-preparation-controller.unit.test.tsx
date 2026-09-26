import {
  getMealPreparationsOut,
  mealOut,
  mealRecipeOut,
} from "@cubby/schemas/meal";
import {
  buildNutrition,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";

import { entityFilterOptions } from "~/entities/entity-filter-options.functions";
import { mock } from "~/lib/test/mock-schema";

import { meal } from "../meal.functions";
import { useMealPreparationController } from "./use-meal-preparation-controller";

it("loads allocation choices only after an editor opens", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const mealId = testShortcode("meal", "MEA-2222");
  const totals: NutritionTotals = withMacros({
    cost: { status: "unavailable", reason: "empty" },
    nutrition: buildNutrition(() => ({
      status: "unavailable",
      reason: "empty",
    })),
  });
  const preparation = mock(getMealPreparationsOut, {
    overrides: {
      mealId,
      preparations: [],
      totals: {
        confirmed: { portionCount: 0, totals },
        projected: { portionCount: 0, totals },
      },
    },
  });
  client.setQueryData(meal.getPreparations.queryKey({ mealId }), preparation);
  client.setQueryData(
    entityFilterOptions.filterOptions.queryKey({
      source: "entity",
      entity: "ledgerParty",
      search: "",
      selectedIds: [],
      include: ["kind"],
      limit: 1000,
    }),
    { items: [], nextCursor: null },
  );
  const target = mock(mealOut, {
    overrides: { id: mealId, date: "2026-03-15", recipes: [], totals },
  });
  client.setQueryData(
    meal.getByDateRange.queryKey({ from: "2026-02-13", to: "2026-04-14" }),
    [target],
  );
  client.setQueryData(
    meal.getByDateRange.queryKey({ from: "2026-02-13", to: "2026-03-15" }),
    [],
  );
  const requests: unknown[] = [];
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.query.queryKey[1] === meal.getByDateRange.id &&
      event.query.state.fetchStatus === "fetching"
    )
      requests.push(event.query.queryKey);
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  const hook = renderHook<
    ReturnType<typeof useMealPreparationController>,
    { date: string | undefined }
  >(
    ({ date }) =>
      useMealPreparationController({
        mealId,
        mealDate: date,
        invalidate: () => {},
      }),
    { initialProps: { date: undefined }, wrapper: Wrapper },
  );
  try {
    await act(async () => {});
    expect(hook.result.current.view).toEqual(preparation);
    expect(hook.result.current.targetMeals).toEqual([]);
    expect(requests).toEqual([]);
    hook.rerender({ date: "2026-03-15" });
    expect(requests).toEqual([]);
    act(() => {
      hook.result.current.openCurrentPreparation(
        "00000000-0000-4000-8000-000000000001",
      );
    });
    expect(hook.result.current.targetMeals.map((row) => row.id)).toEqual([
      mealId,
    ]);
    expect(requests).toEqual([]);
  } finally {
    hook.unmount();
    unsubscribe();
    client.clear();
  }
});

it("offers another meal from the same day as a leftovers source", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const mealId = testShortcode("meal", "MEA-2222");
  const otherMealId = testShortcode("meal", "MEA-3333");
  const totals: NutritionTotals = withMacros({
    cost: { status: "unavailable", reason: "empty" },
    nutrition: buildNutrition(() => ({
      status: "unavailable",
      reason: "empty",
    })),
  });
  client.setQueryData(
    meal.getPreparations.queryKey({ mealId }),
    mock(getMealPreparationsOut, {
      overrides: {
        mealId,
        preparations: [],
        totals: {
          confirmed: { portionCount: 0, totals },
          projected: { portionCount: 0, totals },
        },
      },
    }),
  );
  const currentMeal = mock(mealOut, {
    overrides: { id: mealId, date: "2026-03-15", recipes: [], totals },
  });
  const sourceRecipe = mealRecipeOut.parse({
    id: "00000000-0000-4000-8000-000000000003",
    mealId: otherMealId,
    recipeId: testShortcode("recipe", "RCP-3333"),
    recipe: {
      id: testShortcode("recipe", "RCP-3333"),
      name: "Soup",
      servings: null,
      yield: null,
      totals: null,
    },
    scale: 1,
    sortOrder: null,
    estimatedYieldGrams: null,
    actualYieldGrams: null,
    scaledTotals: totals,
    createdAt: new Date("2026-03-15T12:00:00Z"),
    updatedAt: new Date("2026-03-15T12:00:00Z"),
  });
  const sameDayMeal = mock(mealOut, {
    overrides: {
      id: otherMealId,
      date: "2026-03-15",
      name: "Lunch",
      recipes: [sourceRecipe],
      totals,
    },
  });
  client.setQueryData(
    meal.getByDateRange.queryKey({ from: "2026-02-13", to: "2026-03-15" }),
    [currentMeal, sameDayMeal],
  );
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  const hook = renderHook(
    () =>
      useMealPreparationController({
        mealId,
        mealDate: "2026-03-15",
        invalidate: () => {},
      }),
    { wrapper: Wrapper },
  );
  try {
    expect(hook.result.current.sourcePickerOpen).toBe(false);
    act(() => hook.result.current.beginAddPreparedPortion());
    expect(hook.result.current.sourcePickerOpen).toBe(true);
    expect(hook.result.current.sourceChoices).toHaveLength(1);
    expect(hook.result.current.sourceChoices[0]).toMatchObject({
      mealId: otherMealId,
      mealRecipeId: sourceRecipe.id,
    });
  } finally {
    hook.unmount();
    client.clear();
  }
});
