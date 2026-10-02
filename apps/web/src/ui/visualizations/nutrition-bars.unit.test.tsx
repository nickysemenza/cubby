import {
  buildNutrition,
  type NutritionEstimate,
} from "@cubby/schemas/nutrition";
import { sectionIngredientOut } from "@cubby/schemas/recipe";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IngredientDataItem } from "~/lib/recipe-costing";

import NutritionBars from "./nutrition-bars";

const complete = (lower: number, upper: number | null = null) => ({
  status: "complete" as const,
  lower,
  upper,
  coverage: { covered: 1, total: 1 },
});

const partial = (lower: number, upper: number | null = null) => ({
  status: "partial" as const,
  lower,
  upper,
  coverage: { covered: 1, total: 2 },
});

const unavailable = () =>
  ({ status: "unavailable", reason: "no_data" }) as const;

const ingredientRow = (
  name: string,
  nutrition: NutritionEstimate,
): IngredientDataItem => ({
  ...sectionIngredientOut.parse({
    id: testEntityId("recipe", `nutrition-${name}`),
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: testShortcode("ingredient", `ING-${name}`),
      name,
      aliases: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  }),
  sectionName: null,
  priceInfo: undefined,
  totalsMissing: { price: true, weight: true, nutrients: false },
  nutrition,
});

describe("NutritionBars", () => {
  it("renders a known zero total as data", () => {
    const nutrition = buildNutrition((key) =>
      key === "kcal" || key === "fat" || key === "carbs" || key === "protein"
        ? complete(0)
        : unavailable(),
    );

    render(
      <NutritionBars
        ingredients={[]}
        nutrition={nutrition}
        basisLabel="whole recipe"
      />,
    );

    expect(screen.getByText("0 kcal")).toBeVisible();
    expect(screen.getByText("Known calorie total is 0 kcal")).toBeVisible();
    expect(
      screen.queryByText("No nutrition data available"),
    ).not.toBeInTheDocument();
    for (const macro of ["Fat", "Carbs", "Protein"]) {
      expect(screen.getByRole("region", { name: macro })).toHaveTextContent(
        "0 g",
      );
    }
  });

  it("shows a pending total without attaching measurement units", () => {
    const nutrition = buildNutrition(() => ({
      status: "pending",
      reason: "totals_missing",
    }));

    render(
      <NutritionBars
        ingredients={[]}
        nutrition={nutrition}
        basisLabel="per serving"
      />,
    );

    expect(screen.getAllByText("Pending")).toHaveLength(4);
    expect(screen.getByText("Nutrition calculation pending")).toBeVisible();
    expect(screen.queryByText(/Pending (?:kcal|g)/)).not.toBeInTheDocument();
  });

  it("uses the canonical ranged total and preserves partial ingredient and macro labels", () => {
    const rowNutrition = buildNutrition((key) =>
      key === "kcal" ? partial(100, 140) : unavailable(),
    );
    const nutrition = buildNutrition((key) =>
      key === "kcal"
        ? partial(120, 180)
        : key === "fat"
          ? partial(10, 15)
          : key === "carbs"
            ? complete(20, 24)
            : unavailable(),
    );

    render(
      <NutritionBars
        ingredients={[ingredientRow("Flour", rowNutrition)]}
        nutrition={nutrition}
        basisLabel="whole recipe"
      />,
    );

    const headline = screen.getByText(
      "Calories by ingredient, whole recipe",
    ).parentElement;
    if (headline == null) throw new Error("Missing calorie headline");
    expect(
      within(headline).getByText("120 kcal–180 kcal known · partial"),
    ).toBeVisible();
    expect(
      screen.getByText("Flour · 100 kcal–140 kcal known · partial"),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Fat" })).toHaveTextContent(
      "10 g–15 g known · partial",
    );
    expect(screen.getByRole("region", { name: "Carbs" })).toHaveTextContent(
      "20 g–24 g",
    );
    expect(
      screen.getByText(/Bar widths use known subtotals and lower range bounds/),
    ).toBeVisible();
  });
});
