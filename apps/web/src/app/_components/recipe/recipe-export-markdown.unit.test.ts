import {
  buildNutrition,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import {
  type RecipeOut,
  recipeOut,
  sectionIngredientOut,
} from "@cubby/schemas/recipe";
import {
  testCompleteDataQuality,
  testEntityId,
  testShortcode,
} from "@cubby/schemas/testing";
import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
const unavailableNutrition = buildNutrition(() => ({
  status: "unavailable" as const,
  reason: "no_data" as const,
}));
const unavailableTotals: NutritionTotals = withMacros({
  cost: { status: "unavailable", reason: "no_data" },
  nutrition: unavailableNutrition,
});

import type { IngredientDataItem, RecipeCosting } from "~/lib/recipe-costing";

import { recipeTreeToMarkdown } from "./recipe-export-markdown";
import { buildRecipeTree, type YieldPorts } from "./recipe-tree";

// A stub, not the wasm adapter: this file tests markdown, and the module it
// tests is deliberately wasm-free for the same reason recipe-tree is.
const STUB_PORTS: YieldPorts = {
  yieldFraction: (recipeYield, amounts) => {
    const a = amounts[0];
    return recipeYield && a && recipeYield.unit === a.unit
      ? { fraction: a.value / recipeYield.value, reason: null }
      : { fraction: null, reason: "missingYield" };
  },
  massGrams: (a) => (a.unit === "g" ? a.value : null),
};

const recipeKey = (id: string) => testShortcode("recipe", `RCP-${id}`);
const rowKey = (id: string) => testEntityId("recipe", `row-${id}`);

const mkRow = (id: string, grams: number): IngredientDataItem => ({
  ...sectionIngredientOut.parse({
    id: rowKey(id),
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: testShortcode("ingredient", `ING-${id}`),
      name: id,
      aliases: [],
      naKinds: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  }),
  sectionName: null,
  priceInfo: {
    price: ok({ value: 0, unit: "USD" }),
    gram: ok({ value: grams, unit: "g" }),
    nutrient: ok({}),
  },
  totalsMissing: { price: false, weight: false, nutrients: false },
  nutrition: unavailableNutrition,
});

const mkCosting = (
  rowGrams: Record<string, number>,
  weight: number,
): RecipeCosting => ({
  rows: Object.entries(rowGrams).map(([id, g]) => mkRow(id, g)),
  totals: {
    price: 0,
    priceUpper: undefined,
    nutrients: {},
    nutrientsUpper: undefined,
    weight,
    weightUpper: undefined,
    totalIngredients: Object.keys(rowGrams).length,
    missingByType: { price: [], weight: [], nutrients: [] },
    diagnostics: [],
    estimates: unavailableTotals,
  },
  estimatedRows: new Map(),
  bakerPct: new Map(),
  isFlourRows: new Map(),
});

const ing = (id: string, ingredientId: string, name: string) =>
  sectionIngredientOut.parse({
    id: rowKey(id),
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

const sub = (id: string, recipeId: string, name: string) =>
  sectionIngredientOut.parse({
    id: rowKey(id),
    type: "recipe",
    amounts: [],
    modifier: null,
    rawLine: null,
    ingredient: null,
    recipe: {
      id: recipeKey(recipeId),
      name,
      meta: null,
      forkedFromRecipeId: null,
      forkedFromRecipeName: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  });

const recipeId = recipeKey;

const recipe = (
  id: string,
  name: string,
  ingredients: ReadonlyArray<ReturnType<typeof ing> | ReturnType<typeof sub>>,
): RecipeOut =>
  recipeOut.parse({
    id: recipeId(id),
    name,
    meta: null,
    yield: null,
    servings: null,
    notes: null,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    images: [],
    displayImage: null,
    tags: [],
    sections: [
      {
        id: testEntityId("recipe", `section-${id}`),
        name: null,
        instructions: [],
        ingredients,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    dataQuality: testCompleteDataQuality(),
  });

// Sof (sub) + a duplicated ingredient X, used in both root and sub.
const buildFixture = () => {
  const sof = recipe("r-sof", "Sof", [ing("si-x", "i-x", "X")]);
  const root = recipe("r-root", "R", [
    sub("sr-sof", "r-sof", "Sof"),
    ing("ri-x", "i-x", "X"),
  ]);
  const costingById = new Map<string, RecipeCosting>([
    [recipeId("r-root"), mkCosting({ "sr-sof": 50, "ri-x": 100 }, 150)],
    [recipeId("r-sof"), mkCosting({ "si-x": 100 }, 100)],
  ]);
  return buildRecipeTree(
    root,
    costingById,
    { [recipeId("r-sof")]: sof },
    STUB_PORTS,
  );
};

const stubQty = () => "Q";

describe("recipeTreeToMarkdown — prep", () => {
  const md = recipeTreeToMarkdown(buildFixture(), {
    flavor: "prep",
    quantityText: stubQty,
  });

  it("titles the sheet and lists a full-batch shopping list", () => {
    expect(md).toContain("# R — prep sheet");
    // Full batch: 100 g (root assembly) + 100 g (full Sof batch) = 200 g
    expect(md).toContain("**Shopping list (full batch):** 200 g X");
  });

  it("emits a component heading per node, sub before root", () => {
    const sofAt = md.indexOf("## Sof");
    const rootAt = md.indexOf("## R");
    expect(sofAt).toBeGreaterThan(-1);
    expect(rootAt).toBeGreaterThan(sofAt);
  });

  it("renders checkbox task lines with the injected quantity", () => {
    expect(md).toContain("- [ ] Q X");
  });
});

describe("recipeTreeToMarkdown — nested", () => {
  const md = recipeTreeToMarkdown(buildFixture(), {
    flavor: "nested",
    quantityText: stubQty,
  });

  it("titles by recipe name without the prep suffix", () => {
    expect(md).toContain("# R\n");
    expect(md).not.toContain("prep sheet");
  });

  it("bolds the sub-recipe and indents its children", () => {
    expect(md).toContain("- **Sof** — Q");
    expect(md).toContain("  - X — Q");
  });

  it("annotates scaling percentages", () => {
    expect(md).toMatch(/\(\d+%\)/);
  });
});

describe("recipeTreeToMarkdown — matrix", () => {
  const md = recipeTreeToMarkdown(buildFixture(), {
    flavor: "matrix",
    quantityText: stubQty,
  });

  it("renders a pipe table with component columns and a Total", () => {
    expect(md).toContain("# R — ingredient matrix");
    expect(md).toContain("| Ingredient | Sof | R | Total |");
    expect(md).toContain("| --- | --- | --- | --- |");
  });

  it("places each component's full-batch contribution in its column with a row total", () => {
    // Full batch: 100 g in Sof + 100 g in root → 200 g total
    expect(md).toMatch(/\| X \| 100 g \| 100 g \| 200 g/);
  });
});
