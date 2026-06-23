import { unsafeIngredientId } from "@cubby/schemas/identifiers";
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
  id: "p1",
  name: "Saffron",
  manufacturer: "generic",
  createdAt: new Date(0),
  isIngredient: true,
  usdaUnavailable: false,
  ingredientId: null,
  ...over,
});

const partialProduct = (over: Partial<Partial_> = {}): Partial_ => ({
  id: "p2",
  name: "Aji amarillo",
  manufacturer: "generic",
  coverage: {
    covered: [],
    applicable: ["weight", "volume", "money", "calories"],
  },
  hasPrice: true,
  hasUsdaLink: false,
  usdaUnavailable: false,
  ingredientId: unsafeIngredientId("i2"),
  ...over,
});

const islandedProduct = (over: Partial<Islanded> = {}): Islanded => ({
  id: "p3",
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
    expect(items[0]).toMatchObject({ kind: "none", id: "p1" });
    expect(items[1]).toMatchObject({ kind: "partial", id: "p2" });
    expect(items[2]).toMatchObject({ kind: "islanded", id: "p3" });
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
