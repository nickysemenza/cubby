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

// Stub of the WASM unit tools for the units under test. `kindOf` mirrors
// `amount_kind`'s buckets (unknown units → per-unit "other:" islands like the
// real engine); `convert` does within-kind conversion via a grams/canonical
// factor table — exactly what `conv_amount_to_kind` does, but hand-rolled.
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
  ingredientId: unsafeIngredientId(`ing-${ingredient}`),
  ingredientShortcode: unsafeIngredientShortcode(`ING-${ingredient}`),
  ingredientName: ingredient,
  recipeId: unsafeRecipeId(`rec-${recipe}`),
  recipeShortcode: unsafeRecipeShortcode(`RCP-${recipe}`),
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
    // The reported redundancy: "1 cup ≈ 200 g" and "1 cup ≈ 7 oz" are the same
    // sugar density. Grouping by dimension collapses them; g/oz/tbsp all normalize.
    const rows = [
      row("sugar", [amt(1, "cup"), amt(200, "g")], "a"),
      row("sugar", [amt(1, "cup"), amt(7, "oz")], "b"), // 7 oz ≈ 198 g
      row("sugar", [amt(1, "tbsp"), amt(12.5, "g")], "c"), // per-tbsp → per-cup
    ];
    const out = harvestEquivalences(rows, tools);
    expect(out).toHaveLength(1);
    const c = out[0]!;
    expect(c).toMatchObject({ unitA: "cup", unitB: "g", occurrences: 3 });
    // All three land near ~200 g/cup (tbsp row: 12.5 g/tbsp × 16 ≈ 200; the
    // 7 oz row ≈ 198), so the median is the dominant 200 and the spread is tight.
    expect(c.medianRatio).toBeCloseTo(200, 0);
    expect(c.ratioSpread.max / c.ratioSpread.min).toBeLessThan(1.05);
  });

  it("collapses a line's redundant same-kind measures (no double count)", () => {
    // "5 oz sugar (about ¾ cup; 140 g)" — two weight measures + one volume.
    // Should yield ONE volume↔weight observation, not two.
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
        // "350°F (175°C)" — a bake temp, not an ingredient equivalence.
        row("oven", [amt(350, "F"), amt(175, "C")], "a"),
        // Butter line carrying a stray temp: keep stick↔g, ignore the °F + pan.
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
