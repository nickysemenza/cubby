import { type InfLocation, infLocation } from "@cubby/schemas/location";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { collectTreeProductIds } from "./location-gallery-data";

const location = (
  id: string,
  productIds: string[],
  children?: InfLocation[],
): InfLocation =>
  infLocation.parse({
    id: testShortcode("location", id),
    name: id,
    aliases: [],
    type: "area",
    product: null,
    lastBulkInventory: null,
    aiDescription: null,
    notes: null,
    images: [],
    valuation: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    dataQuality: testCompleteDataQuality(),
    inventoryItems: productIds.map((productId, index) => ({
      id: testShortcode("inventory", `INV-${String(index + 2).repeat(4)}`),
      productId: testShortcode("product", productId),
      productName: productId,
      amount: { value: 1, unit: "item" },
    })),
    children,
  });

describe("collectTreeProductIds", () => {
  it("deduplicates image-summary ids across nested inventory", () => {
    const child = location("LOC-3333", ["PRD-4444", "PRD-5555"]);
    const root = location("LOC-2222", ["PRD-4444"], [child]);

    expect(collectTreeProductIds([root])).toEqual(["PRD-4444", "PRD-5555"]);
  });

  it("indexes empty locations without requiring inventory.list data", () => {
    const empty = location("LOC-2222", []);
    expect(collectTreeProductIds([empty])).toEqual([]);
  });
});
