import { describe, expect, it } from "vitest";
import {
  buildUnitCoverageItems,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-items";

type NoMappings = Parameters<typeof buildUnitCoverageItems>[0][number];
type Islanded = Parameters<typeof buildUnitCoverageItems>[1][number];

const noMappingProduct = (over: Partial<NoMappings> = {}): NoMappings => ({
  id: "p1",
  name: "Saffron",
  manufacturer: "generic",
  createdAt: new Date(0),
  isIngredient: true,
  ...over,
});

const islandedProduct = (over: Partial<Islanded> = {}): Islanded => ({
  id: "p2",
  name: "Brown sugar",
  manufacturer: "Domino",
  islandCount: 2,
  islands: [
    { units: ["cup", "g"], exampleUnit: "cup" },
    { units: ["dollar"], exampleUnit: "dollar" },
  ],
  coverage: { covered: ["weight", "volume"] },
  ...over,
});

describe("buildUnitCoverageItems", () => {
  it("tags each source array with its discriminant and concatenates", () => {
    const items = buildUnitCoverageItems(
      [noMappingProduct()],
      [islandedProduct()],
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "none", id: "p1" });
    expect(items[1]).toMatchObject({ kind: "islanded", id: "p2" });
  });

  it("preserves the source fields under the new discriminant", () => {
    const [none] = buildUnitCoverageItems([noMappingProduct()], []);
    // narrow for type-safe field access
    if (none?.kind !== "none") throw new Error("expected a none item");
    expect(none.isIngredient).toBe(true);

    const [islanded] = buildUnitCoverageItems([], [islandedProduct()]);
    if (islanded?.kind !== "islanded") throw new Error("expected islanded");
    expect(islanded.coverage.covered).toEqual(["weight", "volume"]);
    expect(islanded.islandCount).toBe(2);
  });

  it("returns an empty list when both sources are empty", () => {
    expect(buildUnitCoverageItems([], [])).toEqual([]);
  });
});

describe("unitCoverageGroup", () => {
  const group = (item: UnitCoverageItem) => unitCoverageGroup(item);

  it("splits the merged list into three subgroups", () => {
    expect(
      group({ kind: "none", ...noMappingProduct({ isIngredient: true }) }),
    ).toBe("No conversions · ingredient");
    expect(
      group({ kind: "none", ...noMappingProduct({ isIngredient: false }) }),
    ).toBe("No conversions · other");
    expect(group({ kind: "islanded", ...islandedProduct() })).toBe(
      "Disconnected",
    );
  });
});
