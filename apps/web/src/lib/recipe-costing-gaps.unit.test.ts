import type { Amount } from "@cubby/schemas/codec";
import { describe, expect, it } from "vitest";
import {
  type BaseKind,
  type ConversionCoverage,
  type CoverageTier,
  gradedKinds,
} from "~/lib/conversion-coverage";
import {
  costRecipe,
  cups,
  each,
  g,
  ingredientWith,
  lb,
  makeEntry,
  makeProduct,
  type Product,
} from "~/lib/recipe-costing.fixtures";
import {
  type CostingGap,
  classifyIngredientFix,
  deriveCostingGaps,
} from "~/lib/recipe-costing-gaps";

// One product, given fixed id "prod-p" so single-product cases can assert it.
const prod = (opts?: Parameters<typeof makeProduct>[1]): Product =>
  makeProduct("p", opts);

// ─── Classification corpus ───────────────────────────────────────────────────
// Each case is one ingredient on one line: given the recipe-line amount and the
// product setup, what fix (if any) do we suggest? `expected: null` means the
// line should produce NO gap. Read top-to-bottom as the suggestion's decision
// table — line kind (count/weight/volume) × what the product already has.
interface Case {
  name: string;
  ingredient: string;
  line: Amount[];
  products: Product[];
  // Subset asserted via toMatchObject (so `missing` may be partial too);
  // null = no gap expected.
  expected:
    | (Partial<Omit<CostingGap, "missing">> & {
        missing?: Partial<CostingGap["missing"]>;
      })
    | null;
}

const CASES: Case[] = [
  {
    name: "no product → link a product (covers price + weight)",
    ingredient: "flour",
    line: [cups(2)],
    products: [],
    expected: {
      kind: "no-product",
      productId: null,
      missing: { price: true, weight: true, nutrients: true },
    },
  },
  {
    name: "product, no USDA link, weight unreachable → link USDA",
    ingredient: "sugar",
    line: [cups(1)], // a cup can't reach grams or money with a per-each price
    products: [prod({ price: 2.99 })],
    expected: {
      kind: "link-usda",
      productId: "prod-p",
      missing: { weight: true },
    },
  },
  {
    name: "count line, weight reachable, no price → set per-item price",
    ingredient: "zucchini",
    line: [each(2)], // "1 each = 200 g" makes weight reachable, isolating price
    products: [prod({ mappings: [{ a: each(1), b: g(200) }] })],
    expected: {
      kind: "set-per-item-price",
      lineKind: "count",
      missing: { price: true, weight: false },
    },
  },
  {
    name: "weight line, weight reachable, no money path → purchase mapping",
    ingredient: "oil",
    line: [g(100)], // an lb↔g mapping anchors grams; only money is missing
    products: [prod({ mappings: [{ a: lb(1), b: g(454) }] })],
    expected: {
      kind: "add-purchase-mapping",
      lineKind: "weight",
      missing: { price: true, weight: false },
    },
  },
  {
    name: "volume line, weight reachable, no money path → purchase mapping",
    ingredient: "syrup",
    line: [cups(1)], // cup↔g mapping anchors grams; only money is missing
    products: [prod({ mappings: [{ a: cups(1), b: g(240) }] })],
    expected: {
      kind: "add-purchase-mapping",
      lineKind: "volume",
      missing: { price: true, weight: false },
    },
  },
  {
    name: "USDA-linked + priced, weight unreachable → weight mapping",
    ingredient: "egg",
    line: [each(2)], // ndb set so don't re-suggest USDA; price ok, grams aren't
    products: [prod({ price: 0.25, fdc: 1234 })],
    expected: {
      kind: "add-weight-mapping",
      missing: { price: false, weight: true },
    },
  },
  {
    name: "fully costed (price + each→g) → no gap",
    ingredient: "apple",
    line: [each(1)],
    products: [prod({ price: 0.5, mappings: [{ a: each(1), b: g(180) }] })],
    expected: null,
  },
  {
    name: "unmeasured line (salt to taste) → no gap, never nag",
    ingredient: "salt",
    line: [], // no amount → nothing a mapping could cost
    products: [],
    expected: null,
  },
  {
    name: "multiple products → routes to ingredient hub (productId null)",
    ingredient: "butter",
    line: [cups(1)],
    products: [
      makeProduct("p1", { price: 3 }),
      makeProduct("p2", { price: 4 }),
    ],
    expected: { productId: null },
  },
];

describe("deriveCostingGaps — classification", () => {
  it.each(CASES)("$name", ({ ingredient, line, products, expected }) => {
    const rows = [makeEntry("ing", ingredient, line)];
    const ingMap = { ing: ingredientWith("ing", ingredient, products) };

    const gaps = deriveCostingGaps(costRecipe(rows, ingMap), ingMap);

    if (expected === null) {
      expect(gaps).toHaveLength(0);
    } else {
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject(expected);
    }
  });
});

// ─── Aggregation across rows (not a per-line classification) ──────────────────
describe("deriveCostingGaps — multi-row", () => {
  it("same ingredient on two lines → one deduped gap", () => {
    const rows = [
      makeEntry("h", "salt", [cups(1)]),
      makeEntry("h", "salt", [cups(2)]),
    ];
    const ingMap = { h: ingredientWith("h", "salt", []) };

    const gaps = deriveCostingGaps(costRecipe(rows, ingMap), ingMap);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.ingredientId).toBe("h");
  });

  it("gaps sort by leverage; fully-costed lines drop out", () => {
    const rows = [
      makeEntry("ok", "apple", [each(1)]), // fully costed → excluded
      makeEntry("e", "egg", [each(2)]), // add-weight-mapping (rank 3)
      makeEntry("a", "flour", [cups(2)]), // no-product (rank 0)
    ];
    const ingMap = {
      ok: ingredientWith("ok", "apple", [
        makeProduct("ok", {
          price: 0.5,
          mappings: [{ a: each(1), b: g(180) }],
        }),
      ]),
      e: ingredientWith("e", "egg", [
        makeProduct("e", { price: 0.25, fdc: 1234 }),
      ]),
      a: ingredientWith("a", "flour", []),
    };

    const gaps = deriveCostingGaps(costRecipe(rows, ingMap), ingMap);

    expect(gaps.map((x) => x.kind)).toEqual([
      "no-product",
      "add-weight-mapping",
    ]);
  });
});

// ─── Global workbench path: classifyIngredientFix + N/A (naKinds) ─────────────
// classifyKind only reads `coverage.covered` + `tier`, so build minimal coverage
// literals rather than driving the WASM engine.
const cov = (covered: BaseKind[], tier: CoverageTier): ConversionCoverage => ({
  covered: new Set(covered),
  kindsCovered: covered.length,
  pairs: [],
  tier,
});

describe("classifyIngredientFix — N/A-aware next fix", () => {
  it("weight+price covered, volume applicable but missing → add-volume-mapping (never add-weight)", () => {
    const fix = classifyIngredientFix({
      products: [prod({ price: 1, fdc: 1234 })],
      coverage: cov(["weight", "money", "calories"], "good"),
      applicable: ["weight", "volume", "money", "calories"],
      sampleLineKind: "weight",
    });
    expect(fix).toBe("add-volume-mapping");
  });

  it("volume marked N/A + the other applicable kinds covered → done (drops off worklist)", () => {
    const fix = classifyIngredientFix({
      products: [prod({ price: 1, fdc: 1234 })],
      coverage: cov(["weight", "money", "calories"], "complete"),
      applicable: gradedKinds(["volume"]),
      sampleLineKind: "weight",
    });
    expect(fix).toBe("done");
  });

  it("weight covered, volume N/A, only calories missing → done (not actionable, never add-weight)", () => {
    const fix = classifyIngredientFix({
      products: [prod({ price: 1, fdc: 1234 })],
      coverage: cov(["weight", "money"], "good"),
      applicable: gradedKinds(["volume"]),
      sampleLineKind: "weight",
    });
    expect(fix).toBe("done");
  });

  it("weight still missing (USDA-linked, priced) → add-weight-mapping (regression)", () => {
    const fix = classifyIngredientFix({
      products: [prod({ price: 1, fdc: 1234 })],
      coverage: cov(["money", "calories"], "partial"),
      applicable: ["weight", "volume", "money", "calories"],
      sampleLineKind: "weight",
    });
    expect(fix).toBe("add-weight-mapping");
  });
});
