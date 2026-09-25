import { describe, expect, it } from "vitest";

import { kitsAccountedByParts } from "./product-bulk-add-to-inventory-dialog";

describe("kitsAccountedByParts", () => {
  it("has no answer for a product that is not a kit", () => {
    expect(kitsAccountedByParts([])).toBeNull();
  });

  it("counts a single component as whole kits, not loose units", () => {
    expect(kitsAccountedByParts([{ quantity: 2, onHandUnits: 2 }])).toBe(1);
  });

  it("floors rather than rounding a partial kit up", () => {
    expect(kitsAccountedByParts([{ quantity: 2, onHandUnits: 3 }])).toBe(1);
  });

  it("is limited by the scarcest component", () => {
    expect(
      kitsAccountedByParts([
        { quantity: 2, onHandUnits: 2 },
        { quantity: 1, onHandUnits: 1 },
      ]),
    ).toBe(1);
  });

  it("accounts for nothing when a component is missing entirely", () => {
    expect(
      kitsAccountedByParts([
        { quantity: 1, onHandUnits: 1 },
        { quantity: 3, onHandUnits: 0 },
      ]),
    ).toBe(0);
  });

  it("lets a partially opened multi-pack account for its opened half only", () => {
    expect(kitsAccountedByParts([{ quantity: 4, onHandUnits: 4 }])).toBe(1);
  });

  it("has no answer when a component's units cannot be summed", () => {
    expect(
      kitsAccountedByParts([
        { quantity: 1, onHandUnits: 2 },
        { quantity: 1, onHandUnits: null },
      ]),
    ).toBeNull();
  });
});
