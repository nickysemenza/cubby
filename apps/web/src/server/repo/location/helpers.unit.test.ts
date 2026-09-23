import {
  locationListItemOut,
  locationListRefOut,
} from "@cubby/schemas/location";
import {
  testCompleteDataQuality,
  testEntityId,
  testShortcode,
} from "@cubby/schemas/testing";
import {
  categorySummaryFixture,
  taxonomyId,
} from "tooling/product-category-fixtures";
import { describe, expect, it } from "vitest";

import { resolveProductPricing } from "~/server/repo/product/pricing";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { dbLocationToAPI, dbLocationToListAPI } from "./helpers";
import type { LocationListDB } from "./internal-types";

const LOCATION_ID = testEntityId(
  "location",
  "123e4567-e89b-12d3-a456-426614174000",
);
const PARENT_ID = testEntityId(
  "location",
  "223e4567-e89b-12d3-a456-426614174000",
);
const CHILD_ID = testEntityId(
  "location",
  "323e4567-e89b-12d3-a456-426614174000",
);
const DELETED_CHILD_ID = testEntityId(
  "location",
  "423e4567-e89b-12d3-a456-426614174000",
);
const PRODUCT_ID = testEntityId(
  "product",
  "523e4567-e89b-12d3-a456-426614174000",
);
const DELETED_PRODUCT_ID = testEntityId(
  "product",
  "623e4567-e89b-12d3-a456-426614174000",
);
const INVENTORY_ID = testEntityId(
  "inventory",
  "723e4567-e89b-12d3-a456-426614174000",
);
const DELETED_PRODUCT_INVENTORY_ID = testEntityId(
  "inventory",
  "823e4567-e89b-12d3-a456-426614174000",
);
const IMAGE_SHORTCODE = "IMG-2345";
const IMAGE_ID = testShortcode("image", IMAGE_SHORTCODE);
const DELETED_IMAGE_SHORTCODE = "IMG-6789";
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
  productId: null,
  aiDescription: null,
  notes: null,
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
  shortcode: IMAGE_SHORTCODE,
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
  shortcode: DELETED_IMAGE_SHORTCODE,
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
  growsPlantId: null,
  growsIngredientId: null,
  model: null,
  notes: null,
  expectedQuantity: null,
  categoryId: taxonomyId("food"),
  category: categorySummaryFixture("food"),
  price: 4.5,
  usdaUnavailable: null,
  stockTracked: null,
  labelNutrition: null,
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
    const result = dbLocationToAPI(
      {
        ...baseLocation,
        deletedAt: null,
        images: [
          { image, deletedAt: null },
          { image: deletedImage, deletedAt: null },
          { image, deletedAt: DELETED_AT },
        ],
      },
      undefined,
      testCompleteDataQuality(),
    );

    expect(result).toMatchObject({
      id: testShortcode("location", "LOC-TEST"),
      name: "Pantry",
      images: [{ id: IMAGE_ID, url: getR2PublicUrl(image.key) }],
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
          placement: "stock" as const,
          ownershipMode: "inherit" as const,
          ownerLedgerPartyId: null,
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
          placement: "stock" as const,
          ownershipMode: "inherit" as const,
          ownerLedgerPartyId: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          product: deletedProduct,
        },
      ],
      images: [{ image, deletedAt: null }],
    } satisfies LocationListDB;

    const pricingByProductId = new Map([
      [PRODUCT_ID, resolveProductPricing(product.price)],
    ]);
    const result = dbLocationToListAPI(
      row,
      pricingByProductId,
      undefined,
      testCompleteDataQuality(),
    );

    expect(result.parent).toEqual({
      id: testShortcode("location", "LOC-2345"),
      name: "Kitchen",
      type: "room",
    });
    expect(locationListRefOut.parse(result.parent)).toEqual(result.parent);
    expect(result.children).toEqual([
      {
        id: testShortcode("location", "LOC-3456"),
        name: "Shelf",
        type: "shelf",
      },
    ]);
    expect(result.inventoryEntries).toEqual([
      {
        id: testShortcode("inventory", "INV-2345"),
        amount: { value: 2, unit: "each" },
        valuation: 9,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        product: {
          id: testShortcode("product", "PRD-TEST"),
          name: "Flour",
          primaryGtin: null,
          fdc_id: null,
          manufacturer: "Generic",
          model: null,
          notes: null,
          expectedQuantity: null,
          category: categorySummaryFixture("food"),
          price: 4.5,
          usdaUnavailable: null,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
      },
    ]);
    expect(result.inventoryEntries[0]).not.toHaveProperty("productId");
    expect(result.inventoryEntries[0]?.product).not.toHaveProperty("deletedAt");
    // `displayImages` is attached by `withDisplayImages` in the list function,
    // not by this mapper, so the contract parse gets it here.
    const listRow = { ...result, displayImages: [] };
    expect(locationListItemOut.parse(listRow)).toEqual(listRow);
  });
});
