import type { Amount } from "@cubby/schemas/codec";
import {
  unsafeIngredientId,
  unsafeIngredientShortcode,
  unsafeRecipeId,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import {
  type HarvestRow,
  harvestEquivalences,
  type UnitTools,
} from "~/lib/harvest-equivalences";

const amt = (value: number, unit: string): Amount => ({ value, unit });

const GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};
const ML: Record<string, number> = {
  ml: 1,
  tsp: 4.92892,
  tbsp: 14.7868,
  cup: 236.588,
};
const tools: UnitTools = {
  kindOf: ({ unit }) => {
    if (unit in GRAMS) return "weight";
    if (unit in ML) return "volume";
    if (unit === "C" || unit === "F") return "temperature";
    if (unit === '"') return "length";
    return `other:${unit}`;
  },
  convert: (value, fromUnit, toUnit) => {
    if (fromUnit === toUnit) return value;
    for (const table of [GRAMS, ML]) {
      if (fromUnit in table && toUnit in table) {
        return (value * table[fromUnit]!) / table[toUnit]!;
      }
    }
    return null;
  },
};

const row = (
  ingredient: string,
  amounts: Amount[],
  recipe = "r1",
): HarvestRow => ({
  ingredientId: unsafeIngredientShortcode(`ING-${ingredient}`),
  ingredientEntityId: unsafeIngredientId(`ing-${ingredient}`),
  ingredientName: ingredient,
  recipeId: unsafeRecipeShortcode(`RCP-${recipe}`),
  recipeEntityId: unsafeRecipeId(`rec-${recipe}`),
  recipeName: recipe,
  rawLine: `${ingredient} line`,
  amounts,
});

describe("harvestEquivalences", () => {
  it("drops same-dimension pairs the engine already converts", () => {
    const rows = [
      row("flour", [amt(1, "cup"), amt(16, "tbsp")]), // volume↔volume
      row("sugar", [amt(1, "lb"), amt(16, "oz")]), // weight↔weight
      row("water", [amt(1, "cup"), amt(2, "cup")]), // same unit
      row("salt", [amt(0, "bunch"), amt(5, "cup")]), // degenerate value
    ];
    expect(harvestEquivalences(rows, tools)).toEqual([]);
  });

  it("keeps cross-dimension pairs (density, count↔volume)", () => {
    const out = harvestEquivalences(
      [
        row("kale", [amt(1, "bunch"), amt(5, "cup")]),
        row("pistachios", [amt(2 / 3, "cup"), amt(85, "g")]),
      ],
      tools,
    );
    expect(out).toHaveLength(2);
    const kale = out.find((c) => c.ingredientName === "kale");
    expect(kale).toMatchObject({
      unitA: "bunch",
      unitB: "cup",
      occurrences: 1,
      medianRatio: 5, // cup per bunch
    });
  });

  it("merges weight-unit variants of one density into a single row", () => {
    const rows = [
      row("sugar", [amt(1, "cup"), amt(200, "g")], "a"),
      row("sugar", [amt(1, "cup"), amt(7, "oz")], "b"), // 7 oz ≈ 198 g
      row("sugar", [amt(1, "tbsp"), amt(12.5, "g")], "c"), // per-tbsp → per-cup
    ];
    const out = harvestEquivalences(rows, tools);
    expect(out).toHaveLength(1);
    const c = out[0]!;
    expect(c).toMatchObject({ unitA: "cup", unitB: "g", occurrences: 3 });
    expect(c.medianRatio).toBeCloseTo(200, 0);
    expect(c.ratioSpread.max / c.ratioSpread.min).toBeLessThan(1.05);
  });

  it("collapses a line's redundant same-kind measures (no double count)", () => {
    const out = harvestEquivalences(
      [row("sugar", [amt(5, "oz"), amt(0.75, "cup"), amt(140, "g")])],
      tools,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.occurrences).toBe(1);
  });

  it("drops non-measurement kinds (temperature, length) before pairing", () => {
    const out = harvestEquivalences(
      [
        row("oven", [amt(350, "F"), amt(175, "C")], "a"),
        row(
          "butter",
          [amt(1, "stick"), amt(113, "g"), amt(65, "F"), amt(9, '"')],
          "b",
        ),
      ],
      tools,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ingredientName: "butter",
      unitA: "stick",
      unitB: "g",
      medianRatio: 113,
    });
  });

  it("orients a count/other unit as the '1 X' side for readable labels", () => {
    const out = harvestEquivalences(
      [row("egg", [amt(1, "large"), amt(50, "g")])],
      tools,
    );
    expect(out[0]).toMatchObject({
      unitA: "large",
      unitB: "g",
      medianRatio: 50,
    });
  });
});
