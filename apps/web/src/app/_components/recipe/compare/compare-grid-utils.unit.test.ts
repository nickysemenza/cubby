import { describe, expect, it } from "vitest";
import {
  buildCompareRows,
  compareRowKey,
  computeStats,
  pickDefaultBasis,
  type RecipeRowEntry,
  type RecipeRowMap,
  sumNullable,
} from "./compare-grid-utils";

const entry = (
  over: Partial<RecipeRowEntry> & { label: string },
): RecipeRowEntry => ({
  isFlour: false,
  grams: null,
  bakerPct: null,
  ...over,
});

const recipe = (entries: RecipeRowEntry[]): RecipeRowMap =>
  new Map(entries.map((e) => [compareRowKey(e.label), e]));

describe("compareRowKey", () => {
  it("trims and lowercases so the same ingredient aligns", () => {
    expect(compareRowKey("  All-Purpose Flour ")).toBe("all-purpose flour");
    expect(compareRowKey("FLOUR")).toBe(compareRowKey("flour"));
  });
});

describe("sumNullable", () => {
  it("keeps null only when both operands are null", () => {
    expect(sumNullable(null, null)).toBeNull();
    expect(sumNullable(2, null)).toBe(2);
    expect(sumNullable(null, 3)).toBe(3);
    expect(sumNullable(2, 3)).toBe(5);
  });
});

describe("pickDefaultBasis", () => {
  it("uses baker's % when a flour row has a resolved percentage", () => {
    const set = [
      recipe([
        entry({ label: "Flour", isFlour: true, grams: 100, bakerPct: 100 }),
      ]),
      recipe([entry({ label: "Sugar", grams: 80, bakerPct: 80 })]),
    ];
    expect(pickDefaultBasis(set)).toBe("baker");
  });

  it("falls back to grams when there is no flour", () => {
    const set = [
      recipe([entry({ label: "Chicken", grams: 500 })]),
      recipe([entry({ label: "Rice", grams: 200 })]),
    ];
    expect(pickDefaultBasis(set)).toBe("gram");
  });

  it("falls back to grams when flour has no resolved percentage", () => {
    const set = [
      recipe([entry({ label: "Flour", isFlour: true, grams: 100 })]),
    ];
    expect(pickDefaultBasis(set)).toBe("gram");
  });
});

describe("computeStats", () => {
  it("returns null for an empty set", () => {
    expect(computeStats([])).toBeNull();
  });

  it("computes mean, range, population std, and cv", () => {
    const s = computeStats([95, 121]);
    expect(s).not.toBeNull();
    expect(s?.mean).toBe(108);
    expect(s?.min).toBe(95);
    expect(s?.max).toBe(121);
    // population std: sqrt(((95-108)^2 + (121-108)^2)/2) = 13
    expect(s?.std).toBe(13);
    expect(s?.cv).toBeCloseTo((13 / 108) * 100, 5);
    expect(s?.count).toBe(2);
  });

  it("reports zero spread and cv for a single value", () => {
    const s = computeStats([42]);
    expect(s?.std).toBe(0);
    expect(s?.cv).toBe(0);
    expect(s?.count).toBe(1);
  });

  it("returns null cv when the mean is zero", () => {
    expect(computeStats([0, 0])?.cv).toBeNull();
  });
});

describe("buildCompareRows", () => {
  const set = [
    recipe([
      entry({ label: "Flour", isFlour: true, grams: 200, bakerPct: 100 }),
      entry({ label: "Sugar", grams: 190, bakerPct: 95 }),
      // Listed but unresolvable (no weight/price) → null, not 0.
      entry({ label: "Salt", grams: null, bakerPct: null }),
    ]),
    recipe([
      entry({ label: "flour", isFlour: true, grams: 200, bakerPct: 100 }),
      entry({ label: "Sugar", grams: 242, bakerPct: 121 }),
      entry({ label: "Chocolate", grams: 240, bakerPct: 120 }),
    ]),
  ];

  it("fills absent ingredients with 0 and keeps unresolvable amounts null", () => {
    const rows = buildCompareRows(set, "baker");
    // Both recipes list sugar.
    expect(rows.find((r) => r.key === "sugar")?.values).toEqual([95, 121]);
    // Chocolate is absent from recipe 1 → 0, present in recipe 2.
    expect(rows.find((r) => r.key === "chocolate")?.values).toEqual([0, 120]);
    // Salt is listed-but-unresolvable in recipe 1 (null), absent in recipe 2 (0).
    expect(rows.find((r) => r.key === "salt")?.values).toEqual([null, 0]);
  });

  it("counts absence as 0 in the average (the all-purpose-flour case)", () => {
    const three = [
      recipe([entry({ label: "AP flour", grams: 100, bakerPct: 100 })]),
      recipe([entry({ label: "Cake flour", grams: 100, bakerPct: 100 })]),
      recipe([entry({ label: "AP flour", grams: 100, bakerPct: 100 })]),
    ];
    const ap = buildCompareRows(three, "baker").find(
      (r) => r.key === "ap flour",
    );
    expect(ap?.values).toEqual([100, 0, 100]);
    expect(ap?.average).toBeCloseTo(200 / 3, 5);
  });

  it("averages over present values (absence=0, unresolvable excluded)", () => {
    const rows = buildCompareRows(set, "baker");
    expect(rows.find((r) => r.key === "sugar")?.average).toBe(108);
    // Chocolate: (0 + 120) / 2 = 60.
    expect(rows.find((r) => r.key === "chocolate")?.average).toBe(60);
    // Salt has no resolved amount anywhere (listed-unresolvable + absent), so it
    // stays visible but carries no meaningful average.
    expect(rows.find((r) => r.key === "salt")?.average).toBeNull();
    expect(rows.find((r) => r.key === "salt")?.stats).toBeNull();
  });

  it("attaches cross-recipe stats over present values", () => {
    const rows = buildCompareRows(set, "baker");
    const sugar = rows.find((r) => r.key === "sugar");
    expect(sugar?.stats).toMatchObject({
      mean: 108,
      min: 95,
      max: 121,
      std: 13,
      count: 2,
    });
  });

  it("drops a row only when every recipe lists it but none resolves a value", () => {
    const set2 = [
      recipe([
        entry({ label: "Flour", isFlour: true, grams: 100, bakerPct: 100 }),
        entry({ label: "Mystery", grams: null, bakerPct: null }),
      ]),
      recipe([
        entry({ label: "flour", isFlour: true, grams: 100, bakerPct: 100 }),
        entry({ label: "Mystery", grams: null, bakerPct: null }),
      ]),
    ];
    const rows = buildCompareRows(set2, "baker");
    expect(rows.find((r) => r.key === "mystery")).toBeUndefined();
  });

  it("marks the column with the largest deviation from the average", () => {
    const rows = buildCompareRows(set, "baker");
    const sugar = rows.find((r) => r.key === "sugar");
    // 95 and 121 are equidistant from 108; first wins the strict comparison.
    expect(sugar?.maxDeviationIndex).toBe(0);
    expect(sugar?.maxAbsDeviation).toBe(13);
  });

  it("treats an absent 0 as a deviating value", () => {
    // Chocolate [0, 120], avg 60: the 0 deviates as much as the 120; first wins.
    const choc = buildCompareRows(set, "baker").find(
      (r) => r.key === "chocolate",
    );
    expect(choc?.maxDeviationIndex).toBe(0);
  });

  it("leaves flat rows with no deviation marker", () => {
    const rows = buildCompareRows(set, "baker");
    const flour = rows.find((r) => r.key === "flour");
    expect(flour?.maxDeviationIndex).toBeNull();
    expect(flour?.maxAbsDeviation).toBe(0);
  });

  it("selects the basis value per cell", () => {
    const grams = buildCompareRows(set, "gram");
    expect(grams.find((r) => r.key === "sugar")?.values).toEqual([190, 242]);
  });

  it("sorts flour first, then by how many recipes share the row", () => {
    const rows = buildCompareRows(set, "baker");
    expect(rows[0]?.key).toBe("flour");
    // sugar & chocolate each have 2 present values; sugar's higher average wins
    // the tie. salt has one present value, so it sorts last.
    expect(rows.map((r) => r.key)).toEqual([
      "flour",
      "sugar",
      "chocolate",
      "salt",
    ]);
  });
});
