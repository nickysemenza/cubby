import { describe, expect, it } from "vitest";

import {
  describeAddToInventory,
  kitsAccountedByParts,
} from "./add-to-inventory-preview";

const base = {
  expectedQuantity: 0,
  ownOnHandUnits: null,
  components: [],
  existingAtLocation: null,
};

describe("kitsAccountedByParts", () => {
  it("is unanswerable without parts or with an uncountable part", () => {
    expect(kitsAccountedByParts([])).toBeNull();
    expect(
      kitsAccountedByParts([{ quantity: 2, onHandUnits: null }]),
    ).toBeNull();
  });

  it("counts only complete kits", () => {
    expect(kitsAccountedByParts([{ quantity: 2, onHandUnits: 3 }])).toBe(1);
    expect(
      kitsAccountedByParts([
        { quantity: 1, onHandUnits: 5 },
        { quantity: 2, onHandUnits: 1 },
      ]),
    ).toBe(0);
  });
});

describe("describeAddToInventory", () => {
  it("proposes what the ledger says is outstanding", () => {
    expect(
      describeAddToInventory({
        ...base,
        expectedQuantity: 5,
        ownOnHandUnits: 2,
      }).defaultAmount,
    ).toEqual({ value: 3, unit: "each" });
  });

  it("falls back to one unit when nothing is outstanding", () => {
    for (const [expectedQuantity, ownOnHandUnits] of [
      [0, null],
      [2, 3],
    ] as const) {
      expect(
        describeAddToInventory({ ...base, expectedQuantity, ownOnHandUnits })
          .defaultAmount.value,
      ).toBe(1);
    }
  });

  it("warns when parts already account for every unit bought", () => {
    const preview = describeAddToInventory({
      ...base,
      expectedQuantity: 2,
      components: [{ quantity: 1, onHandUnits: 2 }],
    });
    expect(preview.kitWarning).toEqual({ accounted: 2, expected: 2 });
  });

  it("stays quiet on an empty ledger or a partial kit", () => {
    expect(
      describeAddToInventory({
        ...base,
        components: [{ quantity: 1, onHandUnits: 2 }],
      }).kitWarning,
    ).toBeNull();
    expect(
      describeAddToInventory({
        ...base,
        expectedQuantity: 4,
        components: [{ quantity: 1, onHandUnits: 1 }],
      }).kitWarning,
    ).toBeNull();
  });

  it("reports stock already at the location so the add reads as a merge", () => {
    expect(
      describeAddToInventory({
        ...base,
        existingAtLocation: { value: 3, unit: "each" },
      }).existingAtLocation,
    ).toEqual({ value: 3, unit: "each" });
  });
});
