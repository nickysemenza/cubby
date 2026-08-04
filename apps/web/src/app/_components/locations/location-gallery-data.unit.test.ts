import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { describe, expect, it } from "vitest";
import { buildLocationGalleryData } from "./location-gallery-data";

const location = (
  id: string,
  productIds: string[],
  children?: InfLocation[],
): InfLocation =>
  ({
    id: unsafeLocationShortcode(id),
    name: id,
    images: [],
    inventoryItems: productIds.map((productId, index) => ({
      id: unsafeInventoryShortcode(`INV-${String(index + 2).repeat(4)}`),
      productId: unsafeProductShortcode(productId),
      productName: productId,
      amount: { value: 1, unit: "item" },
    })),
    children,
  }) as unknown as InfLocation;

describe("buildLocationGalleryData", () => {
  it("indexes nested makeTree inventory and deduplicates image-summary ids", () => {
    const child = location("LOC-3333", ["PRD-4444", "PRD-5555"]);
    const root = location("LOC-2222", ["PRD-4444"], [child]);

    const result = buildLocationGalleryData([root]);

    expect(
      result.inventoryByLocation.get(root.id)?.map((x) => x.productId),
    ).toEqual(["PRD-4444"]);
    expect(
      result.inventoryByLocation.get(child.id)?.map((x) => x.productId),
    ).toEqual(["PRD-4444", "PRD-5555"]);
    expect(result.productIds).toEqual(["PRD-4444", "PRD-5555"]);
  });

  it("indexes empty locations without requiring inventory.list data", () => {
    const empty = location("LOC-2222", []);
    const result = buildLocationGalleryData([empty]);

    expect(result.inventoryByLocation.get(empty.id)).toEqual([]);
    expect(result.productIds).toEqual([]);
  });
});
