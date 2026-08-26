import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { asDragData, asDropData } from "./arrange-types";

describe("arrange drag data parsing", () => {
  it("parses branded shortcode fields at the dnd-kit ingress", () => {
    const locationId = testShortcode("location", "shelf");
    const inventoryEntryId = testShortcode("inventory", "item");

    expect(
      asDragData({
        arrangeDrag: "item",
        inventoryEntryId,
        amount: { value: 2, unit: "each" },
        sourceLocationId: locationId,
      }),
    ).toEqual({
      arrangeDrag: "item",
      inventoryEntryId,
      amount: { value: 2, unit: "each" },
      sourceLocationId: locationId,
    });
    expect(asDropData({ arrangeTarget: true, locationId })).toEqual({
      arrangeTarget: true,
      locationId,
    });
  });

  it("rejects malformed or cross-entity identifiers", () => {
    expect(
      asDragData({
        arrangeDrag: "location",
        locationId: testShortcode("product", "wrong-entity"),
        parentId: null,
      }),
    ).toBeNull();
    expect(
      asDropData({ arrangeTarget: true, locationId: "not-a-shortcode" }),
    ).toBeNull();
  });
});
