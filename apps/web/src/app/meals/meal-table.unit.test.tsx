import { mealOut } from "@cubby/schemas/meal";
import { buildNutrition } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ListQueryResponse } from "~/app/_components/hooks/usePaginatedTableCore";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { type MealTableOperations, MealTable } from "./meal-table";

const meal = mealOut.parse({
  id: testShortcode("meal", "ML-4K7M"),
  date: "2026-08-18",
  name: "Weeknight Supper",
  sortOrder: null,
  mealType: "dinner",
  mealKind: "cooked",
  recipes: [],
  images: [],
  totals: {
    cost: {
      status: "complete",
      lower: 18.5,
      upper: null,
      coverage: { covered: 1, total: 1 },
    },
    nutrition: buildNutrition(() => ({
      status: "unavailable",
      reason: "no_data",
    })),
  },
  displayName: "Weeknight Supper",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function mealOperations(
  response: ListQueryResponse<typeof meal>,
): MealTableOperations {
  return {
    // The table's filter and pagination state stays real; this is only the
    // unavailable server list operation for the browser test.
    list: (params) => ({
      queryKey: ["browser-test", "meal-list", params],
      execute: async () => response,
    }),
  };
}

describe("MealTable", () => {
  it("renders server-backed meal rows with their filterable classifications", async () => {
    render(
      <MealTable
        operations={mealOperations({
          items: [meal],
          meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
        })}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("link", { name: "Weeknight Supper" }),
    ).toHaveAttribute("href", `/meals/${meal.id}`);
    expect(screen.getByRole("table", { name: "Meals Table" })).toBeVisible();
    expect(screen.getByText("Dinner")).toBeVisible();
    expect(screen.getByText("Cooked")).toBeVisible();
    expect(screen.getByText("$18.50")).toBeVisible();
  });
});
