import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import { describe, expect, it } from "vitest";
import { dbInventoryEntryToAPI } from "./mappers";
import type { InventoryEntryDeepDB } from "./types";

const INVENTORY_ID = unsafeInventoryId("123e4567-e89b-12d3-a456-426614174000");
const PRODUCT_ID = unsafeProductId("223e4567-e89b-12d3-a456-426614174000");
const LOCATION_ID = unsafeLocationId("323e4567-e89b-12d3-a456-426614174000");
const IMAGE_ID = "423e4567-e89b-12d3-a456-426614174000";
const EXTERNAL_ID = "523e4567-e89b-12d3-a456-426614174000";
const UNIT_MAPPING_ID = "623e4567-e89b-12d3-a456-426614174000";
const DELETED_EXTERNAL_ID = "723e4567-e89b-12d3-a456-426614174000";
const DELETED_UNIT_MAPPING_ID = "823e4567-e89b-12d3-a456-426614174000";
const CREATED_AT = new Date("2024-01-01T00:00:00.000Z");
const UPDATED_AT = new Date("2024-01-02T00:00:00.000Z");
const DELETED_AT = new Date("2024-01-03T00:00:00.000Z");

const baseProduct = {
  id: PRODUCT_ID,
  shortcode: "P-TEST",
  name: "Flour",
  manufacturer: "Generic",
  upc: null,
  fdc_id: null,
  model: "5lb",
  expectedQuantity: null,
  notes: "Keep dry",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  ingredientId: null,
  category: "food" as const,
  price: 4.5,
  usdaUnavailable: null,
};

const baseLocation = {
  id: LOCATION_ID,
  shortcode: "L-TEST",
  name: "Pantry",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  lastBulkInventory: null,
  parentId: null,
  type: "room",
  aiDescription: null,
  valuation: null,
};

const baseInventoryEntry = {
  id: INVENTORY_ID,
  productId: PRODUCT_ID,
  amount: { value: 2, unit: "each" },
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  locationId: LOCATION_ID,
  valuation: 9,
  verifiedAt: null,
};

describe("inventory mappers", () => {
  it("maps detail rows to exact response objects and filters soft-deleted relations", () => {
    const row = {
      ...baseInventoryEntry,
      product: {
        ...baseProduct,
        unitMappings: [
          {
            id: UNIT_MAPPING_ID,
            productId: PRODUCT_ID,
            a: { value: 5, unit: "lb" },
            b: { value: 4.5, unit: "dollar" },
            source: "label",
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            deletedAt: null,
          },
          {
            id: DELETED_UNIT_MAPPING_ID,
            productId: PRODUCT_ID,
            a: { value: 1, unit: "each" },
            b: { value: 1, unit: "dollar" },
            source: "old",
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            deletedAt: DELETED_AT,
          },
        ],
        externalIds: [
          {
            id: EXTERNAL_ID,
            productId: PRODUCT_ID,
            source: "amazon",
            externalId: "B000000001",
            url: "https://example.com/product",
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            deletedAt: null,
          },
          {
            id: DELETED_EXTERNAL_ID,
            productId: PRODUCT_ID,
            source: "old",
            externalId: "OLD",
            url: null,
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            deletedAt: DELETED_AT,
          },
        ],
        images: [
          {
            image: {
              id: IMAGE_ID,
              url: "https://example.com/image.jpg",
              key: "image.jpg",
              filename: "image.jpg",
              size: 100,
              contentType: "image/jpeg",
              status: "UPLOADED" as const,
              createdAt: CREATED_AT,
              updatedAt: UPDATED_AT,
              deletedAt: DELETED_AT,
            },
          },
        ],
      },
      location: {
        ...baseLocation,
        images: [],
      },
    } satisfies InventoryEntryDeepDB;

    const result = dbInventoryEntryToAPI(row);

    expect(result).toEqual({
      id: INVENTORY_ID,
      amount: { value: 2, unit: "each" },
      valuation: 9,
      verifiedAt: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      location: {
        id: LOCATION_ID,
        shortcode: unsafeLocationShortcode("L-TEST"),
        aliases: [],
        lastBulkInventory: null,
        aiDescription: null,
        images: [],
        valuation: null,
        name: "Pantry",
        type: "room",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
      product: {
        id: PRODUCT_ID,
        shortcode: unsafeProductShortcode("P-TEST"),
        images: [],
        externalIds: [
          {
            id: EXTERNAL_ID,
            source: "amazon",
            externalId: "B000000001",
            url: "https://example.com/product",
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
          },
        ],
        price: 4.5,
        usdaUnavailable: null,
        name: "Flour",
        upc: null,
        fdc_id: null,
        manufacturer: "Generic",
        model: "5lb",
        notes: "Keep dry",
        expectedQuantity: null,
        category: "food",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        unitMappings: [
          {
            id: UNIT_MAPPING_ID,
            a: { value: 5, unit: "lb" },
            b: { value: 4.5, unit: "dollar" },
            source: "label",
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            sourceMetadata: {
              type: "product",
              productId: PRODUCT_ID,
            },
          },
        ],
      },
    });
    expect(inventoryWithLocationAndProductOut.parse(result)).toEqual(result);
  });
});
