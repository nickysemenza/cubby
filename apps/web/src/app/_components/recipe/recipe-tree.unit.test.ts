import type { WAmount } from "@cubby/recipebridge";
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
import { err, ok } from "neverthrow";
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

import {
  batchYieldGrams,
  buildIngredientMatrix,
  buildRecipeTree,
  firstExpansionRowIds,
  flattenComponents,
  fullBatchCostByComponent,
  fullBatchNeeds,
  type RecipeTreeNode,
} from "./recipe-tree";
import { WASM_YIELD_PORTS } from "./yield-ports";

const recipeKey = (id: string) => testShortcode("recipe", `RCP-${id}`);
const ingredientKey = (id: string) => testShortcode("ingredient", `ING-${id}`);
const rowKey = (id: string) => testEntityId("recipe", `usage-${id}`);

const mkRow = (id: string, grams: number): IngredientDataItem => ({
  ...sectionIngredientOut.parse({
    id: rowKey(id),
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: ingredientKey(id),
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
    price: err("no price"),
    gram: ok({ value: grams, unit: "g" }),
    nutrient: err("no nutrients"),
  },
  totalsMissing: { price: true, weight: false, nutrients: true },
  nutrition: unavailableNutrition,
});

/** A row carrying a resolved price, optionally ranged ("2–3 cups"). */
const mkPricedRow = (
  id: string,
  price: number,
  upper?: number,
): IngredientDataItem => {
  const priceAmount: Pick<WAmount, "value" | "unit" | "upper_value"> = {
    value: price,
    unit: "dollar",
  };
  if (upper != null) priceAmount.upper_value = upper;
  return {
    ...sectionIngredientOut.parse({
      id: rowKey(id),
      type: "ingredient",
      amounts: [],
      modifier: null,
      rawLine: null,
      recipe: null,
      ingredient: {
        id: ingredientKey(id),
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
      gram: ok({ value: 1, unit: "g" }),
      price: ok(priceAmount),
      nutrient: err("no nutrients"),
    },
    totalsMissing: { price: false, weight: false, nutrients: true },
    nutrition: unavailableNutrition,
  };
};

const mkPricedCosting = (rows: IngredientDataItem[]): RecipeCosting => ({
  rows,
  totals: {
    price: 0,
    nutrients: {},
    weight: 100,
    totalIngredients: rows.length,
    missingByType: { price: [], weight: [], nutrients: [] },
    diagnostics: [],
    estimates: unavailableTotals,
  },
  estimatedRows: new Map(),
  bakerPct: new Map(),
  isFlourRows: new Map(),
});

const mkCosting = (
  rowGrams: Record<string, number>,
  weight: number,
): RecipeCosting => ({
  rows: Object.entries(rowGrams).map(([id, g]) => mkRow(id, g)),
  totals: {
    price: 0,
    nutrients: {},
    weight,
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

// Sub-recipe references carry a written amount, because that's what the engine
// scales against. (They always did in real data; the fixtures used to omit it
// and lean on hand-supplied costing grams instead, which no real costing pass
// would produce for an amount-less row.)
const sub = (
  id: string,
  recipeId: string,
  name: string,
  amounts: ReadonlyArray<{ value: number; unit: string }> = [],
) =>
  sectionIngredientOut.parse({
    id: testEntityId("recipe", `usage-${id}`),
    type: "recipe",
    amounts,
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

const recipe = (
  id: string,
  name: string,
  ingredients: ReadonlyArray<ReturnType<typeof ing> | ReturnType<typeof sub>>,
  opts: { yield?: { value: number; unit: string } } = {},
): RecipeOut =>
  recipeOut.parse({
    id: recipeKey(id),
    name,
    meta: null,
    yield: opts.yield ?? null,
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
      sub("sr-sof", "r-sof", "Soffritto", [{ value: 360, unit: "g" }]),
      ing("ri-mush", "i-mush", "mushroom"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      [recipeKey("r-root"), mkCosting({ "sr-sof": 360, "ri-mush": 600 }, 960)],
      [recipeKey("r-sof"), mkCosting({ "si-onion": 360 }, 360)],
    ]);

    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
    expect(tree.depth).toBe(0);
    expect(tree.cumulativeFactor).toBe(1);

    const rows = firstRows(tree);
    expect(rows[0]?.kind).toBe("subrecipe");
    expect(rows[1]?.kind).toBe("ingredient");

    const subRow = rows[0];
    if (subRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    expect(subRow.child.recipe.id).toBe(recipeKey("r-sof"));
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
    const root = recipe("r-root", "R", [
      sub("sr-sof", "r-sof", "Soffritto", [{ value: 180, unit: "g" }]),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      [recipeKey("r-root"), mkCosting({ "sr-sof": 180 }, 180)], // uses 180 g
      [recipeKey("r-sof"), mkCosting({ "si-onion": 360 }, 360)],
    ]);

    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
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
      sub("sr-chx", "r-chx", "Roast chicken", [{ value: 130, unit: "g" }]),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      [recipeKey("r-root"), mkCosting({ "sr-chx": 130 }, 130)],
      [recipeKey("r-chx"), mkCosting({ "ci-bird": 2000 }, 2000)],
    ]);
    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-chx")]: chicken },
      WASM_YIELD_PORTS,
    );
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
    const costingById = new Map<string, RecipeCosting>([
      [recipeKey("r-root"), mkCosting({}, 0)],
      [recipeKey("r-sof"), mkCosting({ "si-onion": 360 }, 360)],
    ]);
    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
    const subRow = firstRows(tree)[0];
    if (subRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    expect(subRow.child.batchEstimated).toBe(true);
    expect(subRow.child.cumulativeFactor).toBe(1); // falls back to parent
  });

  it("stubs a cycle instead of recursing forever", () => {
    const a = recipe("r-a", "A", [sub("sa", "r-b", "B")]);
    const b = recipe("r-b", "B", [sub("sb", "r-a", "A")]);
    const costingById = new Map<string, RecipeCosting>([
      [recipeKey("r-a"), mkCosting({ sa: 100 }, 100)],
      [recipeKey("r-b"), mkCosting({ sb: 100 }, 100)],
    ]);
    const tree = buildRecipeTree(
      a,
      costingById,
      { [recipeKey("r-a")]: a, [recipeKey("r-b")]: b },
      WASM_YIELD_PORTS,
    );
    const bRow = firstRows(tree)[0];
    if (bRow?.kind !== "subrecipe") throw new Error("expected subrecipe");
    const aStub = firstRows(bRow.child)[0];
    expect(aStub?.kind).toBe("stub");
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    if (aStub?.kind === "stub") expect(aStub.reason).toBe("cycle");
  });

  it("stubs a sub-recipe missing from the closure", () => {
    const root = recipe("r-root", "R", [sub("s1", "r-gone", "Gone")]);
    const tree = buildRecipeTree(
      root,
      new Map([[recipeKey("r-root"), mkCosting({ s1: 50 }, 50)]]),
      {},
      WASM_YIELD_PORTS,
    );
    const row = firstRows(tree)[0];
    expect(row?.kind).toBe("stub");
    // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
    if (row?.kind === "stub") expect(row.reason).toBe("missing");
  });
});

describe("batchYieldGrams", () => {
  const node = (
    recipeYield: { value: number; unit: string } | null,
    weight: number | null,
  ): RecipeTreeNode => {
    const built = buildRecipeTree(
      recipe(
        "yield-node",
        "Yield node",
        [],
        recipeYield ? { yield: recipeYield } : {},
      ),
      new Map(),
      {},
      WASM_YIELD_PORTS,
    );
    return {
      ...built,
      costing: weight == null ? null : mkCosting({}, weight),
    };
  };

  it("uses a mass yield", () => {
    expect(batchYieldGrams(node({ value: 1.2, unit: "kg" }, 999))).toBe(1200);
  });
  it("is null when nothing resolves", () => {
    expect(batchYieldGrams(node(null, null))).toBeNull();
  });

  for (const unit of ["cup", "servings", "loaves", "whole", "ml"]) {
    it(`leaves the non-mass unit ${unit} to the weight fallback`, () => {
      expect(batchYieldGrams(node({ value: 8, unit }, 2000))).toBe(2000);
    });
  }
});

describe("yield fractions come from the engine", () => {
  const fraction = (
    recipeYield: { value: number; unit: string } | null,
    amounts: ReadonlyArray<{ value: number; unit: string }>,
  ) => WASM_YIELD_PORTS.yieldFraction(recipeYield, amounts);

  it("resolves the mass spellings the old table hardcoded", () => {
    expect(
      fraction({ value: 1, unit: "kg" }, [{ value: 250, unit: "g" }]).fraction,
    ).toBeCloseTo(0.25);
    expect(
      fraction({ value: 1, unit: "lb" }, [{ value: 453.592, unit: "g" }])
        .fraction,
    ).toBeCloseTo(1);
  });

  for (const unit of ["kgs", "ozs"]) {
    it(`resolves ${JSON.stringify(unit)}, which the old table missed`, () => {
      expect(
        fraction({ value: 1, unit }, [{ value: 1, unit }]).fraction,
      ).toBeCloseTo(1);
    });
  }

  // Also inverted. The table carried `mg` because the parser has no milligram
  // unit; the engine declines. Zero production recipes use a milligram yield,
  // so this is a recorded, deliberate loss rather than an oversight.
  it("declines a milligram yield, which the old table could answer", () => {
    expect(
      fraction({ value: 1000, unit: "mg" }, [{ value: 1, unit: "g" }]),
    ).toEqual({ fraction: null, reason: "unscalable" });
  });

  // The split that shows what this buys: a volume yield can't be *weighed*
  // (above), but it can absolutely denominate a volume reference — which the
  // old ladder couldn't do without an exact unit-string match, so cup/quart
  // recipes were flagged `batch est.` while showing a correct number.
  it("relates a volume yield to a volume reference", () => {
    expect(
      fraction({ value: 8, unit: "cup" }, [{ value: 1, unit: "quart" }])
        .fraction,
    ).toBeCloseTo(0.5);
  });

  it("relates a count yield across singular and plural", () => {
    expect(
      fraction({ value: 8, unit: "servings" }, [{ value: 2, unit: "serving" }])
        .fraction,
    ).toBeCloseTo(0.25);
  });

  it("names why it declined, so the chip can say what to fix", () => {
    expect(fraction(null, [{ value: 2, unit: "cup" }]).reason).toBe(
      "missingYield",
    );
    expect(
      fraction({ value: 0, unit: "cup" }, [{ value: 2, unit: "cup" }]).reason,
    ).toBe("missingYield");
    expect(
      fraction({ value: 8, unit: "servings" }, [{ value: 200, unit: "g" }])
        .reason,
    ).toBe("unscalable");
    expect(fraction({ value: 4, unit: "cup" }, []).reason).toBe("noAmount");
  });

  it("rejects a negative reference the old unit-ratio accepted", () => {
    expect(
      fraction({ value: 4, unit: "cup" }, [{ value: -2, unit: "cup" }])
        .fraction,
    ).toBeNull();
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
      [recipeKey("r-root"), mkCosting({ "sr-sof": 100, "ri-x": 100 }, 200)],
      [recipeKey("r-sof"), mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
    expect(flattenComponents(tree).map((n) => n.recipe.id)).toEqual([
      recipeKey("r-sof"),
      recipeKey("r-root"),
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
      [recipeKey("r-root"), mkCosting({ "sr-sof": 50, "ri-x": 100 }, 150)],
      [recipeKey("r-sof"), mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
    const x = fullBatchNeeds(tree).find(
      (n) => n.ingredientId === ingredientKey("i-x"),
    );
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
      [
        recipeKey("r-root"),
        mkCosting({ "sr-sof": 50, "ri-x": 100, "ri-y": 40 }, 190),
      ],
      [recipeKey("r-sof"), mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
    const rows = buildIngredientMatrix(tree);

    expect(flattenComponents(tree).map((n) => n.recipe.id)).toEqual([
      recipeKey("r-sof"),
      recipeKey("r-root"),
    ]);

    const xRow = rows.find((r) => r.ingredientId === ingredientKey("i-x"));
    expect(xRow?.byComponent.get(recipeKey("r-sof"))).toBe(100); // full Sof batch
    expect(xRow?.byComponent.get(recipeKey("r-root"))).toBe(100);
    expect(xRow?.total).toBe(200); // = fullBatchNeeds figure

    const yRow = rows.find((r) => r.ingredientId === ingredientKey("i-y"));
    expect(yRow?.byComponent.has(recipeKey("r-sof"))).toBe(false); // only in root
    expect(yRow?.total).toBe(40);
  });

  it("counts a sub-recipe used multiple times as ONE batch", () => {
    const sof = recipe("r-sof", "Sof", [ing("si-x", "i-x", "X")], {
      yield: { value: 100, unit: "g" },
    });
    const root = recipe("r-root", "R", [
      sub("s1", "r-sof", "Sof"),
      sub("s2", "r-sof", "Sof"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      [recipeKey("r-root"), mkCosting({ s1: 50, s2: 30 }, 80)],
      [recipeKey("r-sof"), mkCosting({ "si-x": 100 }, 100)],
    ]);
    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
    const rows = buildIngredientMatrix(tree);

    expect(
      flattenComponents(tree).filter((n) => n.recipe.id === recipeKey("r-sof")),
    ).toHaveLength(1);
    const xRow = rows.find((r) => r.ingredientId === ingredientKey("i-x"));
    expect(xRow?.byComponent.get(recipeKey("r-sof"))).toBe(100);
    expect(xRow?.total).toBe(100);
    expect(
      fullBatchNeeds(tree).find((n) => n.ingredientId === ingredientKey("i-x"))
        ?.grams,
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
    const root = recipe("r-root", "R", [
      sub("sr-sof-1", "r-sof", "Soffritto"),
      ing("ri-x", "i-x", "x"),
      sub("sr-sof-2", "r-sof", "Soffritto"),
    ]);
    const costingById = new Map<string, RecipeCosting>([
      [
        recipeKey("r-root"),
        mkCosting({ "sr-sof-1": 360, "ri-x": 100, "sr-sof-2": 360 }, 820),
      ],
      [recipeKey("r-sof"), mkCosting({ "si-onion": 360 }, 360)],
    ]);

    const tree = buildRecipeTree(
      root,
      costingById,
      { [recipeKey("r-sof")]: sof },
      WASM_YIELD_PORTS,
    );
    const ids = firstExpansionRowIds(tree);
    expect(ids.has(rowKey("sr-sof-1"))).toBe(true);
    expect(ids.has(rowKey("sr-sof-2"))).toBe(false);
    expect(ids.size).toBe(1);
  });
});

describe("fullBatchCostByComponent", () => {
  const priced = (rows: IngredientDataItem[]) => {
    const root = recipe("r-root", "R", [
      ing("a", "i-a", "a"),
      ing("b", "i-b", "b"),
    ]);
    return fullBatchCostByComponent(
      buildRecipeTree(
        root,
        new Map([[recipeKey("r-root"), mkPricedCosting(rows)]]),
        {},
        WASM_YIELD_PORTS,
      ),
    );
  };

  it("sums the component's direct leaf prices", () => {
    const { byComponent, total } = priced([
      mkPricedRow("a", 1.5),
      mkPricedRow("b", 2.25),
    ]);
    expect(byComponent.get(recipeKey("r-root"))?.price).toBeCloseTo(3.75);
    expect(total).toBeCloseTo(3.75);
  });

  it("carries the upper bound a ranged amount produces", () => {
    const { byComponent, total, totalUpper } = priced([
      mkPricedRow("a", 1.0, 2.0),
      mkPricedRow("b", 0.5),
    ]);
    expect(byComponent.get(recipeKey("r-root"))).toEqual({
      price: 1.5,
      priceUpper: 2.5,
    });
    expect(total).toBeCloseTo(1.5);
    expect(totalUpper).toBeCloseTo(2.5);
  });

  it("collapses the range to the point when nothing is ranged", () => {
    // So `formatCurrencyRange`'s `upper > lower` guard never sees "$X – $X".
    const { total, totalUpper } = priced([mkPricedRow("a", 4)]);
    expect(totalUpper).toBe(total);
  });

  it("reports null totals when nothing priced", () => {
    const { total, totalUpper } = priced([mkRow("a", 100)]);
    expect(total).toBeNull();
    expect(totalUpper).toBeNull();
  });
});
