import { describe, expect, it } from "vitest";
import { slimProduct } from "./server";

describe("slimProduct USDA signal", () => {
  // Regression: get_product/list_products gave no USDA signal at all, so an
  // agent couldn't tell a product was linked. USDA resolves at query time
  // (UPC-first, ndb_number fallback) onto `food`; usdaFdcId is the canonical
  // "is it linked" flag and must reflect BOTH paths.

  it("surfaces usdaFdcId for a UPC-only link (ndb_number null)", () => {
    // e.g. Diamond Crystal salt: UPC resolves, ndb_number is null
    const slim = slimProduct({
      id: "p-1",
      name: "kosher salt",
      upc: "013600020019",
      ndb_number: null,
      food: { fdc_id: 2571981 },
    });
    expect(slim.usdaFdcId).toBe(2571981);
    expect(slim.ndb_number).toBeNull();
  });

  it("surfaces usdaFdcId for an ndb-only link (no UPC)", () => {
    // e.g. lard: no UPC, resolves via ndb_number
    const slim = slimProduct({
      id: "p-2",
      name: "lard",
      upc: null,
      ndb_number: 4002,
      food: { fdc_id: 999 },
    });
    expect(slim.usdaFdcId).toBe(999);
    expect(slim.ndb_number).toBe(4002);
  });

  it("reports null usdaFdcId when nothing resolved", () => {
    const slim = slimProduct({
      id: "p-3",
      name: "Bob's Red Mill flour",
      upc: "039978533012",
      ndb_number: null,
      food: null,
    });
    expect(slim.usdaFdcId).toBeNull();
  });

  it("does not conflate externalIds with USDA linkage", () => {
    const slim = slimProduct({
      id: "p-4",
      name: "widget",
      externalIds: [{ source: "amazon", externalId: "B000" }],
      food: null,
    });
    expect(slim.usdaFdcId).toBeNull();
    expect(slim.externalIds).toEqual([
      { source: "amazon", externalId: "B000" },
    ]);
  });
});
