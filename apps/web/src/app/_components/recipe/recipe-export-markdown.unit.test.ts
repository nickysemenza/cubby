import type { RecipeOut } from "@cubby/schemas/recipe";
import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
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

const mkRow = (id: string, grams: number): IngredientDataItem =>
  ({
    id,
    priceInfo: { gram: ok({ value: grams, unit: "g" }) },
  }) as unknown as IngredientDataItem;

const mkCosting = (
  rowGrams: Record<string, number>,
  weight: number,
): RecipeCosting =>
  ({
    rows: Object.entries(rowGrams).map(([id, g]) => mkRow(id, g)),
    totals: { weight },
    estimatedRows: new Map(),
    bakerPct: new Map(),
    isFlourRows: new Map(),
  }) as unknown as RecipeCosting;

const ing = (id: string, ingredientId: string, name: string) =>
  ({
    id,
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: { id: ingredientId, name },
  }) as const;

const sub = (id: string, recipeId: string, name: string) =>
  ({
    id,
    type: "recipe",
    amounts: [],
    modifier: null,
    rawLine: null,
    ingredient: null,
    recipe: { id: recipeId, name },
  }) as const;

const recipe = (
  id: string,
  name: string,
  ingredients: ReadonlyArray<ReturnType<typeof ing> | ReturnType<typeof sub>>,
): RecipeOut =>
  ({
    id,
    name,
    yield: null,
    servings: null,
    notes: null,
    images: [],
    sections: [{ id: `${id}-s`, name: null, instructions: [], ingredients }],
  }) as unknown as RecipeOut;

// Sof (sub) + a duplicated ingredient X, used in both root and sub.
const buildFixture = () => {
  const sof = recipe("r-sof", "Sof", [ing("si-x", "i-x", "X")]);
  const root = recipe("r-root", "R", [
    sub("sr-sof", "r-sof", "Sof"),
    ing("ri-x", "i-x", "X"),
  ]);
  const costingById = new Map<string, RecipeCosting>([
    ["r-root", mkCosting({ "sr-sof": 50, "ri-x": 100 }, 150)],
    ["r-sof", mkCosting({ "si-x": 100 }, 100)],
  ]);
  return buildRecipeTree(root, costingById, { "r-sof": sof }, STUB_PORTS);
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
