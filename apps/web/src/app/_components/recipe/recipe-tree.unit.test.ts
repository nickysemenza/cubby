import type { RecipeOut } from "@cubby/schemas/recipe";
import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { IngredientDataItem, RecipeCosting } from "~/lib/recipe-costing";
import { wasm } from "~/lib/wasm";
import {
  batchYieldGrams,
  buildIngredientMatrix,
  buildRecipeTree,
  firstExpansionRowIds,
  flattenComponents,
  fullBatchNeeds,
  type RecipeTreeNode,
} from "./recipe-tree";

// Minimal fixtures — only the fields buildRecipeTree reads (cast through unknown).
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
  opts: { yield?: { value: number; unit: string } } = {},
): RecipeOut =>
  ({
    id,
    name,
    yield: opts.yield ?? null,
    servings: null,
    notes: null,
    images: [],
    sections: [{ id: `${id}-s`, name: null, instructions: [], ingredients }],
  }) as unknown as RecipeOut;

const firstRows = (node: RecipeTreeNode) => node.sections[0]?.rows ?? [];

describe("buildRecipeTree", () => {
  it("expands a sub-recipe inline with root factor 1", () => {
    const sof = recipe(
      "r-sof",
      "Soffritto",
      [ing("si-onion", "i-onion", "onion")],
      {
        yield: { value: 360, unit: "g" },
      },
    );
    const root = recipe("r-root", "Bolognese", [
      sub("sr-sof", "r-sof", "Soffritto"),
      ing("ri-mush", "i-mush", "mushroom"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      ["r-root", mkCosting({ "sr-sof": 360, "ri-mush": 600 }, 960)],
      ["r-sof", mkCosting({ "si-onion": 360 }, 360)],
    ]);

    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    expect(tree.depth).toBe(0);
    expect(tree.cumulativeFactor).toBe(1);

    const rows = firstRows(tree);
    expect(rows[0]?.kind).toBe("subrecipe");
    expect(rows[1]?.kind).toBe("ingredient");

    const subRow = rows[0];
    if (subRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    // as-used 360 of a 360 batch → factor 1
    expect(subRow.child.recipe.id).toBe("r-sof");
    expect(subRow.child.cumulativeFactor).toBe(1);
    expect(subRow.child.batchEstimated).toBe(false);
  });

  it("derives cumulativeFactor from as-used ÷ yield grams", () => {
    const sof = recipe(
      "r-sof",
      "Soffritto",
      [ing("si-onion", "i-onion", "onion")],
      { yield: { value: 360, unit: "g" } },
    );
    const root = recipe("r-root", "R", [sub("sr-sof", "r-sof", "Soffritto")]);
    const costingById = new Map<string, RecipeCosting>([
      ["r-root", mkCosting({ "sr-sof": 180 }, 180)], // uses 180 g
      ["r-sof", mkCosting({ "si-onion": 360 }, 360)],
    ]);

    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    const subRow = firstRows(tree)[0];
    if (subRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    expect(subRow.child.cumulativeFactor).toBeCloseTo(0.5);
    expect(subRow.child.batchEstimated).toBe(false);
  });

  it("scales against yield, not the ingredient-weight sum (cooked-loss)", () => {
    // A roast: 2000 g of raw ingredients yields 800 g of cooked product; used at
    // 130 g. The factor must be 130/800 (the yield), not 130/2000 (raw weight).
    const chicken = recipe(
      "r-chx",
      "Roast chicken",
      [ing("ci-bird", "i-bird", "whole chicken")],
      { yield: { value: 800, unit: "g" } },
    );
    const root = recipe("r-root", "Bowl", [
      sub("sr-chx", "r-chx", "Roast chicken"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      ["r-root", mkCosting({ "sr-chx": 130 }, 130)],
      ["r-chx", mkCosting({ "ci-bird": 2000 }, 2000)],
    ]);
    const tree = buildRecipeTree(root, costingById, { "r-chx": chicken });
    const subRow = firstRows(tree)[0];
    if (subRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    expect(subRow.child.cumulativeFactor).toBeCloseTo(130 / 800);
    expect(subRow.child.batchEstimated).toBe(false);
  });

  it("flags batchEstimated when grams can't be resolved", () => {
    const sof = recipe("r-sof", "Soffritto", [
      ing("si-onion", "i-onion", "onion"),
    ]);
    const root = recipe("r-root", "R", [sub("sr-sof", "r-sof", "Soffritto")]);
    // root costing lacks the sub row → no as-used grams
    const costingById = new Map<string, RecipeCosting>([
      ["r-root", mkCosting({}, 0)],
      ["r-sof", mkCosting({ "si-onion": 360 }, 360)],
    ]);
    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    const subRow = firstRows(tree)[0];
    if (subRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    expect(subRow.child.batchEstimated).toBe(true);
    expect(subRow.child.cumulativeFactor).toBe(1); // falls back to parent
  });

  it("stubs a cycle instead of recursing forever", () => {
    const a = recipe("r-a", "A", [sub("sa", "r-b", "B")]);
    const b = recipe("r-b", "B", [sub("sb", "r-a", "A")]);
    const costingById = new Map<string, RecipeCosting>([
      ["r-a", mkCosting({ sa: 100 }, 100)],
      ["r-b", mkCosting({ sb: 100 }, 100)],
    ]);
    const tree = buildRecipeTree(a, costingById, { "r-a": a, "r-b": b });
    const bRow = firstRows(tree)[0];
    if (bRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    const aStub = firstRows(bRow.child)[0];
    expect(aStub?.kind).toBe("stub");
    if (aStub?.kind === "stub") expect(aStub.reason).toBe("cycle");
  });

  it("stubs a sub-recipe missing from the closure", () => {
    const root = recipe("r-root", "R", [sub("s1", "r-gone", "Gone")]);
    const tree = buildRecipeTree(
      root,
      new Map([["r-root", mkCosting({ s1: 50 }, 50)]]),
      {},
    );
    const row = firstRows(tree)[0];
    expect(row?.kind).toBe("stub");
    if (row?.kind === "stub") expect(row.reason).toBe("missing");
  });
});

describe("batchYieldGrams", () => {
  const node = (
    recipeYield: { value: number; unit: string } | null,
    weight: number | null,
  ): RecipeTreeNode =>
    ({
      recipe: { yield: recipeYield },
      costing: weight == null ? null : { totals: { weight } },
    }) as unknown as RecipeTreeNode;

  it("uses a mass yield", () => {
    expect(batchYieldGrams(node({ value: 1.2, unit: "kg" }, 999))).toBe(1200);
  });
  it("falls back to ingredient weight for a non-mass yield", () => {
    expect(batchYieldGrams(node({ value: 8, unit: "servings" }, 2000))).toBe(
      2000,
    );
  });
  it("is null when nothing resolves", () => {
    expect(batchYieldGrams(node(null, null))).toBeNull();
  });

  // Drift tripwire for the module's `MASS_TO_GRAMS` table, which re-derives the
  // parser's own mass normalization (the denominator costing/engine.rs's
  // `sub_recipe_pairs` scales a sub-recipe by). The table can't simply call the
  // engine: `conv_amount_to_kind` integer-rounds, so it answers 454 g for 1 lb
  // where the engine's internal factor is 453.592 — see the comment on the table.
  // This asks the engine at 1e6× instead, where the ±0.5 g rounding washes out to
  // ~1e-9 relative, and compares against the live table via `batchYieldGrams`. An
  // upstream factor change (or an edit to the table) fails HERE rather than
  // silently desyncing the prep sheet from the costing engine.
  describe("MASS_TO_GRAMS matches the engine", () => {
    const PROBE = 1e6;
    const engineGrams = (unit: string): number | null => {
      try {
        return wasm.conv_amount_to_kind([], "weight", { value: PROBE, unit })
          .value;
      } catch {
        return null;
      }
    };

    for (const unit of [
      "g",
      "gram",
      "grams",
      "kg",
      "kilogram",
      "kilograms",
      "oz",
      "ounce",
      "ounces",
      "lb",
      "lbs",
      "pound",
      "pounds",
    ]) {
      it(`agrees on ${unit}`, () => {
        const table = batchYieldGrams(node({ value: PROBE, unit }, null));
        const engine = engineGrams(unit);
        expect(engine).not.toBeNull();
        expect(table).not.toBeNull();
        // Relative comparison: the engine still rounds to whole grams, which at
        // this probe size is ~1e-9 of the value.
        expect(table).toBeCloseTo(engine ?? Number.NaN, 3);
      });
    }

    // The table's one entry the engine can't confirm — the parser has no
    // milligram unit, so `mg` is an `Other` unit with no path to weight. Left in
    // the table because dropping it would change behavior for a (nonsensical)
    // milligram yield; pinned here so the asymmetry is deliberate, not forgotten.
    it("keeps mg, which the parser does not know", () => {
      expect(engineGrams("mg")).toBeNull();
      expect(batchYieldGrams(node({ value: 1000, unit: "mg" }, null))).toBe(1);
    });

    // The known gap the table's fixed spellings leave, and the reason to keep
    // chasing the engine call. Casing is covered (the table lowercases), but the
    // plural forms nobody typed in ("kgs", "ozs" — the parser's `singular()`
    // strips those) fall through to null and quietly downgrade the node to
    // `batchEstimated`.
    for (const unit of ["kgs", "ozs"]) {
      it(`misses ${JSON.stringify(unit)}, which the engine handles`, () => {
        expect(engineGrams(unit)).not.toBeNull();
        expect(batchYieldGrams(node({ value: 1, unit }, null))).toBeNull();
      });
    }

    // Non-mass yields have no density with no mappings supplied, so both sides
    // decline and the caller falls back to the ingredient-weight sum.
    for (const unit of ["cup", "servings", "loaves", "whole", "ml"]) {
      it(`leaves the non-mass unit ${unit} to the weight fallback`, () => {
        expect(engineGrams(unit)).toBeNull();
        expect(batchYieldGrams(node({ value: 8, unit }, 2000))).toBe(2000);
      });
    }
  });
});

describe("flattenComponents", () => {
  it("orders sub-recipes before their parent (post-order, deduped)", () => {
    const sof = recipe("r-sof", "Sof", [ing("si-x", "i-x", "X")]);
    const root = recipe("r-root", "R", [
      sub("sr-sof", "r-sof", "Sof"),
      ing("ri-x", "i-x", "X"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      ["r-root", mkCosting({ "sr-sof": 100, "ri-x": 100 }, 200)],
      ["r-sof", mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    expect(flattenComponents(tree).map((n) => n.recipe.id)).toEqual([
      "r-sof",
      "r-root",
    ]);
  });
});

describe("fullBatchNeeds", () => {
  it("sums each component's full batch (you buy for the batch, not the portion used)", () => {
    const sof = recipe("r-sof", "Sof", [ing("si-x", "i-x", "X")], {
      yield: { value: 100, unit: "g" },
    });
    const root = recipe("r-root", "R", [
      sub("sr-sof", "r-sof", "Sof"),
      ing("ri-x", "i-x", "X"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      // The root uses only 50 g of the Sof batch, but you make the whole 100 g.
      ["r-root", mkCosting({ "sr-sof": 50, "ri-x": 100 }, 150)],
      ["r-sof", mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    const x = fullBatchNeeds(tree).find((n) => n.ingredientId === "i-x");
    expect(x?.grams).toBe(200); // 100 (root assembly) + 100 (full Sof batch)
  });
});

describe("buildIngredientMatrix", () => {
  it("pivots ingredients × components at full batch", () => {
    const sof = recipe("r-sof", "Sof", [ing("si-x", "i-x", "X")], {
      yield: { value: 100, unit: "g" },
    });
    const root = recipe("r-root", "R", [
      sub("sr-sof", "r-sof", "Sof"),
      ing("ri-x", "i-x", "X"),
      ing("ri-y", "i-y", "Y"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      ["r-root", mkCosting({ "sr-sof": 50, "ri-x": 100, "ri-y": 40 }, 190)],
      ["r-sof", mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    const rows = buildIngredientMatrix(tree);

    expect(flattenComponents(tree).map((n) => n.recipe.id)).toEqual([
      "r-sof",
      "r-root",
    ]);

    const xRow = rows.find((r) => r.ingredientId === "i-x");
    expect(xRow?.byComponent.get("r-sof")).toBe(100); // full Sof batch
    expect(xRow?.byComponent.get("r-root")).toBe(100);
    expect(xRow?.total).toBe(200); // = fullBatchNeeds figure

    const yRow = rows.find((r) => r.ingredientId === "i-y");
    expect(yRow?.byComponent.has("r-sof")).toBe(false); // only in root
    expect(yRow?.total).toBe(40);
  });

  it("counts a sub-recipe used multiple times as ONE batch", () => {
    const sof = recipe("r-sof", "Sof", [ing("si-x", "i-x", "X")], {
      yield: { value: 100, unit: "g" },
    });
    // Root references Sof twice (chicken's white + dark meat) — one batch made.
    const root = recipe("r-root", "R", [
      sub("s1", "r-sof", "Sof"),
      sub("s2", "r-sof", "Sof"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      ["r-root", mkCosting({ s1: 50, s2: 30 }, 80)],
      ["r-sof", mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    const rows = buildIngredientMatrix(tree);

    // One Sof column at its full batch (100 g) — NOT 2× and NOT the as-used 80 g.
    expect(
      flattenComponents(tree).filter((n) => n.recipe.id === "r-sof"),
    ).toHaveLength(1);
    const xRow = rows.find((r) => r.ingredientId === "i-x");
    expect(xRow?.byComponent.get("r-sof")).toBe(100);
    expect(xRow?.total).toBe(100);
    expect(
      fullBatchNeeds(tree).find((n) => n.ingredientId === "i-x")?.grams,
    ).toBe(100);
  });
});

describe("firstExpansionRowIds", () => {
  it("marks only the first occurrence of a repeated sub-recipe", () => {
    const sof = recipe(
      "r-sof",
      "Soffritto",
      [ing("si-onion", "i-onion", "onion")],
      { yield: { value: 360, unit: "g" } },
    );
    // Same sub-recipe (r-sof) referenced by two different rows, with a leaf in
    // between: only the first row expands; the second is a "see above" pointer.
    const root = recipe("r-root", "R", [
      sub("sr-sof-1", "r-sof", "Soffritto"),
      ing("ri-x", "i-x", "x"),
      sub("sr-sof-2", "r-sof", "Soffritto"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      [
        "r-root",
        mkCosting({ "sr-sof-1": 360, "ri-x": 100, "sr-sof-2": 360 }, 820),
      ],
      ["r-sof", mkCosting({ "si-onion": 360 }, 360)],
    ]);

    const tree = buildRecipeTree(root, costingById, { "r-sof": sof });
    const ids = firstExpansionRowIds(tree);
    expect(ids.has("sr-sof-1")).toBe(true);
    expect(ids.has("sr-sof-2")).toBe(false);
    expect(ids.size).toBe(1);
  });
});
