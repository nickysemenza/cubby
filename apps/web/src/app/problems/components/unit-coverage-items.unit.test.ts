import { testShortcode } from "@cubby/schemas/testing";

import { describe, expect, it } from "vitest";
import {
  buildUnitCoverageItems,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-items";

type NoMappings = Parameters<typeof buildUnitCoverageItems>[0][number];
type Partial_ = Parameters<typeof buildUnitCoverageItems>[1][number];
type Islanded = Parameters<typeof buildUnitCoverageItems>[2][number];

const noMappingProduct = (over: Partial<NoMappings> = {}): NoMappings => ({
  id: testShortcode("product", "PRD-P111"),
  name: "Saffron",
  manufacturer: "generic",
  createdAt: new Date(0),
  isIngredient: true,
  usdaUnavailable: false,
  ingredientId: null,
  ...over,
});

const partialProduct = (over: Partial<Partial_> = {}): Partial_ => ({
  id: testShortcode("product", "PRD-P222"),
  name: "Aji amarillo",
  manufacturer: "generic",
  coverage: {
    covered: [],
    applicable: ["weight", "volume", "money", "calories"],
  },
  hasPrice: true,
  hasUsdaLink: false,
  usdaUnavailable: false,
  ingredientId: testShortcode("ingredient", "ING-I222"),
  ...over,
});

const islandedProduct = (over: Partial<Islanded> = {}): Islanded => ({
  id: testShortcode("product", "PRD-P333"),
  name: "Brown sugar",
  manufacturer: "Domino",
  islandCount: 2,
  islands: [
    { units: ["cup", "g"], exampleUnit: "cup" },
    { units: ["dollar"], exampleUnit: "dollar" },
  ],
  coverage: {
    covered: ["weight", "volume"],
    applicable: ["weight", "volume", "money", "calories"],
  },
  ...over,
});

describe("buildUnitCoverageItems", () => {
  it("tags each source array with its discriminant and concatenates", () => {
    const items = buildUnitCoverageItems(
      [noMappingProduct()],
      [partialProduct()],
      [islandedProduct()],
    );

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "none",
      id: testShortcode("product", "PRD-P111"),
    });
    expect(items[1]).toMatchObject({
      kind: "partial",
      id: testShortcode("product", "PRD-P222"),
    });
    expect(items[2]).toMatchObject({
      kind: "islanded",
      id: testShortcode("product", "PRD-P333"),
    });
  });

  it("preserves the source fields under the new discriminant", () => {
    const [none] = buildUnitCoverageItems([noMappingProduct()], [], []);
    if (none?.kind !== "none") throw new Error("expected a none item");
    expect(none.isIngredient).toBe(true);

    const [islanded] = buildUnitCoverageItems([], [], [islandedProduct()]);
    if (islanded?.kind !== "islanded") throw new Error("expected islanded");
    expect(islanded.coverage.covered).toEqual(["weight", "volume"]);
    expect(islanded.islandCount).toBe(2);
  });

  it("returns an empty list when all sources are empty", () => {
    expect(buildUnitCoverageItems([], [], [])).toEqual([]);
  });
});

describe("unitCoverageGroup", () => {
  const group = (item: UnitCoverageItem) => unitCoverageGroup(item);

  it("splits the merged list into four subgroups", () => {
    expect(
      group({ kind: "none", ...noMappingProduct({ isIngredient: true }) }),
    ).toBe("No conversions · ingredient");
    expect(
      group({ kind: "none", ...noMappingProduct({ isIngredient: false }) }),
    ).toBe("No conversions · other");
    expect(group({ kind: "partial", ...partialProduct() })).toBe(
      "Incomplete coverage",
    );
    expect(group({ kind: "islanded", ...islandedProduct() })).toBe(
      "Disconnected",
    );
  });
});
