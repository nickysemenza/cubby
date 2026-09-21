import { describe, expect, it } from "vitest";

import { categorySummaryFixture } from "../../../../tooling/product-category-fixtures";
import {
  getLocationGlyph,
  getLocationIcon,
  getLocationTypeGroup,
  typeSupportsQrCode,
} from "./location-type-theme";

/**
 * A location that IS a Product carries no `type` — the SKU is its form factor.
 * Every theme lookup therefore has to answer for null rather than throw, and
 * the answers must stay useful.
 */
describe("product-backed locations (null type)", () => {
  it("labels a linked location QR-eligible", () => {
    // Having a product means it is a physical vessel you can stick a label on.
    expect(typeSupportsQrCode(null)).toBe(true);
    // Unchanged for the structural cases either side of it.
    expect(typeSupportsQrCode("house")).toBe(false);
    expect(typeSupportsQrCode("room")).toBe(false);
    expect(typeSupportsQrCode("box")).toBe(true);
  });

  it("groups a linked location with the containers", () => {
    expect(getLocationTypeGroup(null)).toBe("containers");
    expect(getLocationTypeGroup("house")).toBe("spaces");
  });

  it("resolves the glyph from the product's category", () => {
    const storage = getLocationGlyph({
      type: null,
      product: { category: categorySummaryFixture("storage") },
    });
    const tools = getLocationGlyph({
      type: null,
      product: { category: categorySummaryFixture("tools") },
    });
    expect(storage).not.toBe(tools);
  });

  it("falls back to a generic glyph when the product has no category", () => {
    const uncategorized = getLocationGlyph({
      type: null,
      product: { category: null },
    });
    expect(uncategorized).toBe(getLocationIcon(null));
  });

  it("prefers an explicit type over the product when both are somehow set", () => {
    // Not a state the writers produce, but the resolver must be total.
    expect(
      getLocationGlyph({
        type: "room",
        product: { category: categorySummaryFixture("storage") },
      }),
    ).toBe(getLocationIcon("room"));
  });
});
