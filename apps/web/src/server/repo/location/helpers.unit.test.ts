import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  locationListItemOut,
  locationListRefOut,
} from "@cubby/schemas/location";
import { describe, expect, it } from "vitest";
import { dbLocationToAPI, dbLocationToListAPI } from "./helpers";
import type { LocationListDB } from "./internal-types";

const LOCATION_ID = unsafeLocationId("123e4567-e89b-12d3-a456-426614174000");
const PARENT_ID = unsafeLocationId("223e4567-e89b-12d3-a456-426614174000");
const CHILD_ID = unsafeLocationId("323e4567-e89b-12d3-a456-426614174000");
const DELETED_CHILD_ID = unsafeLocationId(
  "423e4567-e89b-12d3-a456-426614174000",
);
const PRODUCT_ID = unsafeProductId("523e4567-e89b-12d3-a456-426614174000");
const DELETED_PRODUCT_ID = unsafeProductId(
  "623e4567-e89b-12d3-a456-426614174000",
);
const INVENTORY_ID = unsafeInventoryId("723e4567-e89b-12d3-a456-426614174000");
const DELETED_PRODUCT_INVENTORY_ID = unsafeInventoryId(
  "823e4567-e89b-12d3-a456-426614174000",
);
const IMAGE_ID = "923e4567-e89b-12d3-a456-426614174000";
const DELETED_IMAGE_ID = "a23e4567-e89b-12d3-a456-426614174000";
const CREATED_AT = new Date("2024-01-01T00:00:00.000Z");
const UPDATED_AT = new Date("2024-01-02T00:00:00.000Z");
const DELETED_AT = new Date("2024-01-03T00:00:00.000Z");

const baseLocation = {
  id: LOCATION_ID,
  shortcode: "LOC-TEST",
  name: "Pantry",
  type: "room",
  parentId: null,
  lastBulkInventory: null,
  aiDescription: null,
  valuation: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
};

const parentLocation = {
  ...baseLocation,
  id: PARENT_ID,
  shortcode: "LOC-2345",
  name: "Kitchen",
  deletedAt: null,
};

const childLocation = {
  ...baseLocation,
  id: CHILD_ID,
  shortcode: "LOC-3456",
  name: "Shelf",
  type: "shelf",
  parentId: LOCATION_ID,
  deletedAt: null,
};

const deletedChildLocation = {
  ...childLocation,
  id: DELETED_CHILD_ID,
  shortcode: "LOC-4567",
  deletedAt: DELETED_AT,
};

const image = {
  id: IMAGE_ID,
  url: "https://example.com/location.jpg",
  key: "location.jpg",
  filename: "location.jpg",
  size: 100,
  contentType: "image/jpeg",
  status: "UPLOADED" as const,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
};

const deletedImage = {
  ...image,
  id: DELETED_IMAGE_ID,
  url: "https://example.com/deleted.jpg",
  deletedAt: DELETED_AT,
};

const product = {
  id: PRODUCT_ID,
  shortcode: "PRD-TEST",
  name: "Flour",
  manufacturer: "Generic",
  tags: [],
  upc: null,
  fdc_id: null,
  model: null,
  notes: null,
  expectedQuantity: null,
  category: "food" as const,
  price: 4.5,
  usdaUnavailable: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
  ingredientId: null,
};

const deletedProduct = {
  ...product,
  id: DELETED_PRODUCT_ID,
  shortcode: "PRD-9WK4",
  deletedAt: DELETED_AT,
};

describe("location mappers", () => {
  it("maps scalar location rows and filters deleted image rows", () => {
    const result = dbLocationToAPI({
      ...baseLocation,
      deletedAt: null,
      images: [
        { image, deletedAt: null },
        { image: deletedImage, deletedAt: null },
        { image, deletedAt: DELETED_AT },
      ],
    });

    expect(result).toMatchObject({
      id: LOCATION_ID,
      shortcode: unsafeLocationShortcode("LOC-TEST"),
      name: "Pantry",
      images: [{ id: IMAGE_ID, url: "https://example.com/location.jpg" }],
    });
    expect(result.images).toHaveLength(1);
    expect(result).not.toHaveProperty("deletedAt");
  });

  it("maps list rows to shallow parent, child, and inventory contracts", () => {
    const row = {
      ...baseLocation,
      deletedAt: null,
      parent: parentLocation,
      children: [childLocation, deletedChildLocation],
      inventoryEntries: [
        {
          id: INVENTORY_ID,
          shortcode: "INV-2345",
          productId: PRODUCT_ID,
          locationId: LOCATION_ID,
          amount: { value: 2, unit: "each" },
          valuation: 9,
          verifiedAt: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          product,
        },
        {
          id: DELETED_PRODUCT_INVENTORY_ID,
          shortcode: "INV-3456",
          productId: DELETED_PRODUCT_ID,
          locationId: LOCATION_ID,
          amount: { value: 1, unit: "each" },
          valuation: 1,
          verifiedAt: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          product: deletedProduct,
        },
      ],
      images: [{ image, deletedAt: null }],
    } satisfies LocationListDB;

    const result = dbLocationToListAPI(row);

    expect(result.parent).toEqual({
      id: PARENT_ID,
      shortcode: unsafeLocationShortcode("LOC-2345"),
      name: "Kitchen",
      type: "room",
    });
    expect(locationListRefOut.parse(result.parent)).toEqual(result.parent);
    expect(result.children).toEqual([
      {
        id: CHILD_ID,
        shortcode: unsafeLocationShortcode("LOC-3456"),
        name: "Shelf",
        type: "shelf",
      },
    ]);
    expect(result.inventoryEntries).toEqual([
      {
        id: INVENTORY_ID,
        amount: { value: 2, unit: "each" },
        valuation: 9,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        product: {
          id: PRODUCT_ID,
          shortcode: unsafeProductShortcode("PRD-TEST"),
          name: "Flour",
          upc: null,
          fdc_id: null,
          manufacturer: "Generic",
          model: null,
          notes: null,
          expectedQuantity: null,
          category: "food",
          price: 4.5,
          usdaUnavailable: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
      },
    ]);
    expect(result.inventoryEntries[0]).not.toHaveProperty("productId");
    expect(result.inventoryEntries[0]?.product).not.toHaveProperty("deletedAt");
    expect(locationListItemOut.parse(result)).toEqual(result);
  });
});
