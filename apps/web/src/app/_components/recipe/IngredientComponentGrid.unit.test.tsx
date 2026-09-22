import {
  buildNutrition,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import {
  recipeOut,
  type SectionIngredientOut,
  sectionIngredientOut,
} from "@cubby/schemas/recipe";
import {
  testCompleteDataQuality,
  testEntityId,
  testShortcode,
} from "@cubby/schemas/testing";
import { act, render, screen, within } from "@testing-library/react";
import { ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
const unavailableNutrition = buildNutrition(() => ({
  status: "unavailable" as const,
  reason: "no_data" as const,
}));
const unavailableTotals: NutritionTotals = withMacros({
  cost: { status: "unavailable", reason: "no_data" },
  nutrition: unavailableNutrition,
});

import { EMPTY_MARK } from "~/components/matrix/matrix-chrome";
import type { RecipeCosting } from "~/lib/recipe-costing";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { IngredientComponentGrid } from "./IngredientComponentGrid";
import type { RecipeTreeNode } from "./recipe-tree";

const DOUGH_ID = testShortcode("recipe", "RCP-DOUGH");
const ROOT_ID = testShortcode("recipe", "RCP-ROOT");

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(async () => {
  harness = createBrowserTestHarness();
  await act(async () => {
    await harness.loadRouter();
  });
});

afterEach(() => {
  harness.dispose();
});

const recipe = (id: string, name: string) =>
  recipeOut.parse({
    id: testShortcode("recipe", id),
    name,
    meta: null,
    yield: null,
    servings: null,
    notes: null,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    source: null,
    images: [],
    sections: [],
    tags: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    dataQuality: testCompleteDataQuality(),
  });

const ingredient = (
  id: string,
  name: string,
  ingredientId = id,
): SectionIngredientOut =>
  sectionIngredientOut.parse({
    id: testEntityId("recipe", `usage-${id}`),
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: testShortcode("ingredient", `ING-${ingredientId}`),
      name,
      aliases: [],
      naKinds: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  });

const costing = (
  rows: ReadonlyArray<{
    row: SectionIngredientOut;
    grams: number;
    price: number;
    priceUpper?: number;
  }>,
): RecipeCosting => ({
  rows: rows.map(({ row, grams, price, priceUpper }) => {
    const priceAmount =
      priceUpper == null
        ? { value: price, unit: "USD" }
        : { value: price, unit: "USD", upper_value: priceUpper };
    return {
      ...row,
      sectionName: null,
      priceInfo: {
        price: ok(priceAmount),
        gram: ok({ value: grams, unit: "g" }),
        nutrient: ok({}),
      },
      totalsMissing: { price: false, weight: false, nutrients: false },
      nutrition: unavailableNutrition,
    };
  }),
  totals: {
    price: 1.5,
    weight: 510,
    totalIngredients: rows.length,
    nutrients: {},
    missingByType: { price: [], weight: [], nutrients: [] },
    diagnostics: [],
    estimates: unavailableTotals,
  },
  estimatedRows: new Map(),
  bakerPct: new Map(),
  isFlourRows: new Map(),
});

const flour = ingredient("flour", "flour");
const doughSalt = ingredient("dough-salt", "salt", "salt");
const assemblySalt = ingredient("assembly-salt", "salt", "salt");
const doughReference = ingredient("dough-reference", "Dough");

const dough: RecipeTreeNode = {
  recipe: recipe(DOUGH_ID, "Dough"),
  costing: costing([
    { row: flour, grams: 500, price: 1.5, priceUpper: 2.25 },
    { row: doughSalt, grams: 10, price: 0 },
  ]),
  depth: 1,
  cumulativeFactor: 1,
  batchEstimated: false,
  batchEstimatedReason: null,
  batchGrams: null,
  baseRowId: null,
  sections: [
    {
      id: "dough-section",
      name: null,
      steps: [],
      rows: [
        { kind: "ingredient", id: flour.id, row: flour, grams: 500, pct: 100 },
        {
          kind: "ingredient",
          id: doughSalt.id,
          row: doughSalt,
          grams: 10,
          pct: 2,
        },
      ],
    },
  ],
};

const tree: RecipeTreeNode = {
  recipe: recipe(ROOT_ID, "Assembly"),
  costing: null,
  depth: 0,
  cumulativeFactor: 1,
  batchEstimated: false,
  batchEstimatedReason: null,
  batchGrams: null,
  baseRowId: null,
  sections: [
    {
      id: "assembly-section",
      name: null,
      steps: [],
      rows: [
        {
          kind: "subrecipe",
          id: doughReference.id,
          row: doughReference,
          grams: 100,
          pct: 100,
          child: dough,
        },
        {
          kind: "ingredient",
          id: assemblySalt.id,
          row: assemblySalt,
          grams: 2,
          pct: 2,
        },
      ],
    },
  ],
};

const rowCells = (name: string) => {
  const rowHeader = screen.getByRole("rowheader", { name });
  const row = rowHeader.parentElement;
  if (!row) throw new Error(`Missing row for ${name}`);
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
};

describe("IngredientComponentGrid", () => {
  it("renders a column per component and a row per ingredient", () => {
    render(<IngredientComponentGrid tree={tree} />, {
      wrapper: harness.routerWrapper,
    });

    expect(screen.getByRole("columnheader", { name: /^Dough/ })).toBeVisible();
    expect(screen.getByRole("rowheader", { name: "flour" })).toBeVisible();
    expect(screen.getByRole("rowheader", { name: "salt" })).toBeVisible();
  });

  it("marks a component that doesn't use an ingredient, and totals the row", () => {
    render(<IngredientComponentGrid tree={tree} />, {
      wrapper: harness.routerWrapper,
    });

    expect(rowCells("flour")).toEqual(["500 g", EMPTY_MARK, "500 g"]);
    expect(rowCells("salt")).toEqual(["10 g", "2 g", "12 g"]);
  });

  it("renders the Subtotal footer and omits Cost unless asked", () => {
    render(<IngredientComponentGrid tree={tree} />, {
      wrapper: harness.routerWrapper,
    });

    expect(screen.getByRole("rowheader", { name: "Subtotal" })).toBeVisible();
    expect(screen.queryByRole("rowheader", { name: "Cost" })).toBeNull();
    expect(rowCells("Subtotal")).toEqual(["510 g", "2 g", "512 g"]);
  });

  it("adds the Cost footer row when showCost is set", () => {
    render(<IngredientComponentGrid tree={tree} showCost />, {
      wrapper: harness.routerWrapper,
    });

    expect(rowCells("Cost")).toEqual([
      "$1.50 – $2.25",
      EMPTY_MARK,
      "$1.50 – $2.25",
    ]);
  });
});
