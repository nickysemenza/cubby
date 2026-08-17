import { describe, expect, it } from "vitest";
import { heroPresence } from "./product-hero-presence";

/**
 * The shape that broke in production: `PRD-HSDX` is a wire rack in service as
 * `chrome wire shelf`, with no loose stock. The hero read
 * `ON HAND 0 · LOCATIONS 0 · NOT STOCKED` above a section listing the shelf.
 */
describe("heroPresence", () => {
  it("reports a product held only as locations, not zero", () => {
    const result = heroPresence({
      entryCount: 0,
      entryUnit: undefined,
      onHandUnits: 1,
      locationCount: 1,
    });

    expect(result.onHand).toEqual({
      kind: "amount",
      label: "On hand",
      // No shelf row to borrow a unit from; a location is one unit.
      amount: { value: 1, unit: "each" },
    });
    expect(result.presenceCount).toBe(1);
    expect(result.inStock).toBe(true);
  });

  it("sums loose stock and bins in service", () => {
    const result = heroPresence({
      entryCount: 1,
      entryUnit: "each",
      onHandUnits: 3,
      locationCount: 2,
    });
    expect(result.onHand).toMatchObject({ amount: { value: 3, unit: "each" } });
    expect(result.presenceCount).toBe(3);
  });

  it("keeps the shelf's own unit when there is one", () => {
    const result = heroPresence({
      entryCount: 2,
      entryUnit: "lb",
      onHandUnits: 5,
      locationCount: 0,
    });
    expect(result.onHand).toMatchObject({ amount: { value: 5, unit: "lb" } });
  });

  it("falls back to a row count only when no sum is meaningful", () => {
    // Mixed units on the shelf — the server returns null rather than adding
    // `3 lb` to `2 each`.
    const result = heroPresence({
      entryCount: 2,
      entryUnit: "lb",
      onHandUnits: null,
      locationCount: 0,
    });
    expect(result.onHand).toEqual({
      kind: "entries",
      label: "Entries",
      count: 2,
    });
    // Still present — "we can't total it" is not "we don't have it".
    expect(result.inStock).toBe(true);
  });

  it("is unstocked only when neither a shelf nor a bin holds it", () => {
    const result = heroPresence({
      entryCount: 0,
      entryUnit: undefined,
      onHandUnits: null,
      locationCount: 0,
    });
    expect(result.presenceCount).toBe(0);
    expect(result.inStock).toBe(false);
  });
});
