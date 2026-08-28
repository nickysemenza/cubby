import { describe, expect, it } from "vitest";

import { heroPresence } from "./product-hero-presence";

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
    expect(result.presenceCount).toBe(0);
  });

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

describe("heroPresence location stat", () => {
  const base = {
    entryUnit: "each",
    componentCount: 0,
  };

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
