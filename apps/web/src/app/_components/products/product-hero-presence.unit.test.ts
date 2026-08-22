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
      componentCount: 0,
    });

    expect(result.onHand).toEqual({
      kind: "amount",
      label: "On hand",
      // No shelf row to borrow a unit from; a location is one unit.
      amount: { value: 1, unit: "each" },
    });
    expect(result.presenceCount).toBe(1);
    expect(result.stamp).toEqual({ label: "In stock", tone: "green" });
  });

  it("sums loose stock and bins in service", () => {
    const result = heroPresence({
      entryCount: 1,
      entryUnit: "each",
      onHandUnits: 3,
      locationCount: 2,
      componentCount: 0,
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
      componentCount: 0,
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
      componentCount: 0,
    });
    expect(result.onHand).toEqual({
      kind: "entries",
      label: "Entries",
      count: 2,
    });
    // Still present — "we can't total it" is not "we don't have it".
    expect(result.stamp).toEqual({ label: "In stock", tone: "green" });
  });

  it("is unstocked only when neither a shelf nor a bin holds it", () => {
    const result = heroPresence({
      entryCount: 0,
      entryUnit: undefined,
      onHandUnits: null,
      locationCount: 0,
      componentCount: 0,
    });
    expect(result.presenceCount).toBe(0);
    expect(result.stamp).toEqual({ label: "Not stocked", tone: "ink" });
  });

  /**
   * The second shape that read wrong: PRD-DHXW, a 2-piece nightstand set split
   * into a composition record. It keeps the Expense (`EXPECTED 1`) and holds
   * nothing under its own name, while both nightstands sit on the component.
   * "Not stocked" over `EXPECTED 1` read as a deficit on a set that is fully
   * accounted for.
   *
   * The ledger is right and stays: that `1` is what the projection multiplies
   * by each edge's quantity to give the parts their expected counts.
   */
  it("says a decomposed kit is stocked as its parts, not unstocked", () => {
    const result = heroPresence({
      entryCount: 0,
      entryUnit: undefined,
      onHandUnits: null,
      locationCount: 0,
      componentCount: 1,
    });
    expect(result.stamp).toEqual({ label: "Stocked as parts", tone: "green" });
    // Presence is untouched: nothing is on a shelf under THIS name, and the
    // stat row must keep saying so.
    expect(result.presenceCount).toBe(0);
  });

  /**
   * A kit still sealed in its box is stocked as itself. Its own shelf row is
   * the more specific fact, so it outranks the components.
   */
  it("prefers a kit's own stock over its components", () => {
    const result = heroPresence({
      entryCount: 1,
      entryUnit: "each",
      onHandUnits: 1,
      locationCount: 0,
      componentCount: 3,
    });
    expect(result.stamp).toEqual({ label: "In stock", tone: "green" });
  });

  it("stamps a plain stocked product in stock", () => {
    const result = heroPresence({
      entryCount: 2,
      entryUnit: "each",
      onHandUnits: 2,
      locationCount: 0,
      componentCount: 0,
    });
    expect(result.stamp).toEqual({ label: "In stock", tone: "green" });
  });
});
