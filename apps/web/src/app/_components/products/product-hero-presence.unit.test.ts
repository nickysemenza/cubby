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
      stockedLocationIds: [],
      identityLocationIds: ["LOC-RACK"],
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
      stockedLocationIds: ["LOC-SHELF"],
      identityLocationIds: ["LOC-BIN-A", "LOC-BIN-B"],
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
      stockedLocationIds: ["LOC-SHELF-A", "LOC-SHELF-B"],
      identityLocationIds: [],
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
      stockedLocationIds: ["LOC-SHELF-A", "LOC-SHELF-B"],
      identityLocationIds: [],
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
      stockedLocationIds: [],
      identityLocationIds: [],
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
      stockedLocationIds: [],
      identityLocationIds: [],
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
      stockedLocationIds: ["LOC-SHELF"],
      identityLocationIds: [],
      componentCount: 3,
    });
    expect(result.stamp).toEqual({ label: "In stock", tone: "green" });
  });

  it("stamps a plain stocked product in stock", () => {
    const result = heroPresence({
      entryCount: 2,
      entryUnit: "each",
      onHandUnits: 2,
      stockedLocationIds: ["LOC-SHELF-A", "LOC-SHELF-B"],
      identityLocationIds: [],
      componentCount: 0,
    });
    expect(result.stamp).toEqual({ label: "In stock", tone: "green" });
  });
});

/**
 * The "Locations" stat, which has now broken in both directions — once
 * counting only shelves it sits on, once only locations it IS. Every case
 * below is the same invariant from a different side: the stat may never read 0
 * while the Stocked At table beneath it renders a row.
 *
 * All three populations live in one suite deliberately. Fixing one direction
 * is what broke the other, so a test covering only one flips the bug back.
 */
describe("heroPresence location stat", () => {
  const base = {
    entryUnit: "each" as string | undefined,
    componentCount: 0,
  };

  // The reported shape: PRD-H3M4, a length of square tube with one STOCK row
  // at `metal rack` and no location of its own. Read "LOCATIONS 0" directly
  // above that row.
  it("counts a shelf the product merely sits on", () => {
    const result = heroPresence({
      ...base,
      entryCount: 1,
      onHandUnits: 1,
      stockedLocationIds: ["LOC-T8HE"],
      identityLocationIds: [],
    });
    expect(result.locationCount).toBe(1);
  });

  // The mirror shape, and the reason the narrow count was introduced:
  // PRD-HSDX, a wire rack in service as a shelf with no loose stock.
  it("counts a location the product IS", () => {
    const result = heroPresence({
      ...base,
      entryCount: 0,
      entryUnit: undefined,
      onHandUnits: 1,
      stockedLocationIds: [],
      identityLocationIds: ["LOC-HSDX"],
    });
    expect(result.locationCount).toBe(1);
  });

  // PRD-2C4Q, a 4-pack of racks: one is in service as `metal rack`, the rest
  // are boxed in `main area`. Two genuinely different places, and the narrow
  // count reported only one of them.
  it("counts both populations when a product has each", () => {
    const result = heroPresence({
      ...base,
      entryCount: 1,
      onHandUnits: 2,
      stockedLocationIds: ["LOC-2T7V"],
      identityLocationIds: ["LOC-T8HE"],
    });
    expect(result.locationCount).toBe(2);
  });

  it("counts one place once when a bin holds loose stock of its own SKU", () => {
    const result = heroPresence({
      ...base,
      entryCount: 1,
      onHandUnits: 2,
      stockedLocationIds: ["LOC-TOTE"],
      identityLocationIds: ["LOC-TOTE"],
    });
    expect(result.locationCount).toBe(1);
  });

  it("counts places, not rows, when one shelf holds several entries", () => {
    const result = heroPresence({
      ...base,
      entryCount: 3,
      onHandUnits: 3,
      stockedLocationIds: ["LOC-SHELF", "LOC-SHELF", "LOC-SHELF"],
      identityLocationIds: [],
    });
    expect(result.locationCount).toBe(1);
  });

  it("reads 0 only when the product is nowhere", () => {
    const result = heroPresence({
      ...base,
      entryCount: 0,
      entryUnit: undefined,
      onHandUnits: null,
      stockedLocationIds: [],
      identityLocationIds: [],
    });
    expect(result.locationCount).toBe(0);
    expect(result.stamp).toEqual({ label: "Not stocked", tone: "ink" });
  });

  // The narrow count feeds the on-hand sum, where widening it would
  // double-count every container promoted to a Location. Presence must keep
  // reading the identity population alone.
  it("leaves presenceCount on the identity population", () => {
    const result = heroPresence({
      ...base,
      entryCount: 1,
      onHandUnits: 1,
      stockedLocationIds: ["LOC-SHELF-A", "LOC-SHELF-B"],
      identityLocationIds: [],
    });
    expect(result.locationCount).toBe(2);
    expect(result.presenceCount).toBe(1);
  });
});
