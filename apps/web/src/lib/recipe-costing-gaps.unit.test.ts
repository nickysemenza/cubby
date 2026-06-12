import type { Amount } from "@cubby/schemas/codec";
import {
  unsafeIngredientId,
  unsafeProductId,
  unsafeProductShortcode,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import { beforeAll, describe, expect, test } from "vitest";
import {
  type CostingRow,
  computeRecipeCosting,
  type RecipeCosting,
} from "~/lib/recipe-costing";
import { type CostingGap, deriveCostingGaps } from "~/lib/recipe-costing-gaps";
import { ensureWasm } from "~/lib/wasm";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";

beforeAll(async () => {
  await ensureWasm();
});

// ─── Fixture builders ────────────────────────────────────────────────────────
const TS = new Date();
const dates = { createdAt: TS, updatedAt: TS };

type Product = IngredientWithFoodOut["product"][number];

const makeProduct = (
  idStr: string,
  opts: {
    price?: number | null;
    ndb?: number | null;
    upc?: string | null;
    food?: Product["food"];
    mappings?: { a: Amount; b: Amount }[];
  } = {},
): Product => ({
  id: unsafeProductId(`prod-${idStr}`),
  shortcode: unsafeProductShortcode("P-TEST"),
  name: idStr,
  upc: opts.upc ?? null,
  ndb_number: opts.ndb ?? null,
  manufacturer: "",
  category: null,
  model: null,
  expectedQuantity: null,
  price: opts.price ?? null,
  images: [],
  externalIds: [],
  food: opts.food ?? null,
  unitMappings: (opts.mappings ?? []).map(({ a, b }, i) => ({
    id: `${idStr}-m${i}`,
    a,
    b,
    source: "test",
    sourceMetadata: { type: "manual" as const },
    ...dates,
  })),
  ...dates,
});

const makeIngredient = (
  idStr: string,
  name: string,
  products: Product[],
): IngredientWithFoodOut => ({
  id: unsafeIngredientId(idStr),
  name,
  recipe: null,
  appearsInRecipes: [],
  aliases: [],
  ...dates,
  product: products,
});

const makeEntry = (
  idStr: string,
  name: string,
  amounts: Amount[],
): CostingRow => ({
  id: idStr,
  type: "ingredient",
  ...dates,
  ingredient: { id: unsafeIngredientId(idStr), name, ...dates },
  recipe: null,
  amounts,
  modifier: null,
  sectionName: null,
});

const getName = (i: SectionIngredientOut): string =>
  i.type === "ingredient" ? i.ingredient.name : "sub-recipe";

const makeRoot = (rows: CostingRow[]): RecipeOut => ({
  id: unsafeRecipeId("root"),
  name: "root",
  ...dates,
  meta: null,
  yield: null,
  images: [],
  sections: rows.map((row, i) => {
    const { sectionName, ...ingredient } = row;
    return {
      id: `root-sec-${i}`,
      name: sectionName,
      instructions: [],
      ingredients: [ingredient],
      ...dates,
    };
  }),
});

const cost = (
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut>,
): RecipeCosting => {
  const root = makeRoot(rows);
  const c = computeRecipeCosting([root], ingMap, getName).get(root.id);
  if (!c) throw new Error("engine returned no costing for the root");
  return c;
};

const g = (value: number): Amount => ({ value, unit: "g" });
const each = (value: number): Amount => ({ value, unit: "each" });
const cups = (value: number): Amount => ({ value, unit: "cup" });
const lb = (value: number): Amount => ({ value, unit: "lb" });

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
    products: [prod({ price: 0.25, ndb: 1234 })],
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
  test.each(CASES)("$name", ({ ingredient, line, products, expected }) => {
    const rows = [makeEntry("ing", ingredient, line)];
    const ingMap = { ing: makeIngredient("ing", ingredient, products) };

    const gaps = deriveCostingGaps(cost(rows, ingMap), ingMap);

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
  test("same ingredient on two lines → one deduped gap", () => {
    const rows = [
      makeEntry("h", "salt", [cups(1)]),
      makeEntry("h", "salt", [cups(2)]),
    ];
    const ingMap = { h: makeIngredient("h", "salt", []) };

    const gaps = deriveCostingGaps(cost(rows, ingMap), ingMap);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.ingredientId).toBe("h");
  });

  test("gaps sort by leverage; fully-costed lines drop out", () => {
    const rows = [
      makeEntry("ok", "apple", [each(1)]), // fully costed → excluded
      makeEntry("e", "egg", [each(2)]), // add-weight-mapping (rank 3)
      makeEntry("a", "flour", [cups(2)]), // no-product (rank 0)
    ];
    const ingMap = {
      ok: makeIngredient("ok", "apple", [
        makeProduct("ok", {
          price: 0.5,
          mappings: [{ a: each(1), b: g(180) }],
        }),
      ]),
      e: makeIngredient("e", "egg", [
        makeProduct("e", { price: 0.25, ndb: 1234 }),
      ]),
      a: makeIngredient("a", "flour", []),
    };

    const gaps = deriveCostingGaps(cost(rows, ingMap), ingMap);

    expect(gaps.map((x) => x.kind)).toEqual([
      "no-product",
      "add-weight-mapping",
    ]);
  });
});
