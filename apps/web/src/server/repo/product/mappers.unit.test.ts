import {
  unsafeIngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  productPickerItemOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { productWithIngredientAndInventoryAndMappingsOut } from "@cubby/schemas/product-responses";
import { describe, expect, it } from "vitest";
import {
  dbProductToAPI,
  dbProductToPickerItemAPI,
  dbProductToTopLevelAPI,
} from "./mappers";
import type { ProductDeepDB } from "./types";

const PRODUCT_ID = unsafeProductId("123e4567-e89b-12d3-a456-426614174000");
const INGREDIENT_ID = unsafeIngredientId(
  "223e4567-e89b-12d3-a456-426614174000",
);
const LOCATION_ID = unsafeLocationId("323e4567-e89b-12d3-a456-426614174000");
const INVENTORY_ID = unsafeInventoryId("423e4567-e89b-12d3-a456-426614174000");
const IMAGE_ID = "523e4567-e89b-12d3-a456-426614174000";
const JOIN_IMAGE_ID = "623e4567-e89b-12d3-a456-426614174000";
const DELETED_IMAGE_ID = "723e4567-e89b-12d3-a456-426614174000";
const EXTERNAL_ID = "823e4567-e89b-12d3-a456-426614174000";
const DELETED_EXTERNAL_ID = "923e4567-e89b-12d3-a456-426614174000";
const UNIT_MAPPING_ID = "a23e4567-e89b-12d3-a456-426614174000";
const DELETED_UNIT_MAPPING_ID = "b23e4567-e89b-12d3-a456-426614174000";
const CREATED_AT = new Date("2024-01-01T00:00:00.000Z");
const UPDATED_AT = new Date("2024-01-02T00:00:00.000Z");
const DELETED_AT = new Date("2024-01-03T00:00:00.000Z");

const baseProduct = {
  id: PRODUCT_ID,
  shortcode: "P-TEST",
  name: "Flour",
  manufacturer: "Generic",
  upc: "012345678905",
  fdc_id: null,
  model: "5lb",
  notes: "Keep dry",
  expectedQuantity: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  ingredientId: INGREDIENT_ID,
  category: "food" as const,
  price: 4.5,
  usdaUnavailable: null,
};

const baseImage = {
  id: IMAGE_ID,
  url: "https://example.com/image.jpg",
  key: "image.jpg",
  filename: "image.jpg",
  size: 100,
  contentType: "image/jpeg",
  status: "UPLOADED" as const,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
};

const joinedImage = {
  id: JOIN_IMAGE_ID,
  url: "https://example.com/joined.jpg",
  key: "joined.jpg",
  filename: "joined.jpg",
  size: 200,
  contentType: "image/jpeg",
  status: "UPLOADED" as const,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
};

const deletedImage = {
  ...baseImage,
  id: DELETED_IMAGE_ID,
  deletedAt: DELETED_AT,
};

const activeExternalId = {
  id: EXTERNAL_ID,
  productId: PRODUCT_ID,
  source: "amazon",
  externalId: "B000000001",
  url: "https://example.com/product",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
};

const deletedExternalId = {
  ...activeExternalId,
  id: DELETED_EXTERNAL_ID,
  source: "old",
  externalId: "OLD",
  url: null,
  deletedAt: DELETED_AT,
};

const activeUnitMapping = {
  id: UNIT_MAPPING_ID,
  productId: PRODUCT_ID,
  a: { value: 5, unit: "lb" },
  b: { value: 4.5, unit: "dollar" },
  source: "label",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
};

const deletedUnitMapping = {
  ...activeUnitMapping,
  id: DELETED_UNIT_MAPPING_ID,
  source: "old",
  deletedAt: DELETED_AT,
};

describe("product mappers", () => {
  it("maps top-level products exactly and filters soft-deleted relations", () => {
    const result = dbProductToTopLevelAPI({
      ...baseProduct,
      images: [
        baseImage,
        deletedImage,
        { image: joinedImage, deletedAt: null },
        { image: baseImage, deletedAt: DELETED_AT },
      ],
      externalIds: [activeExternalId, deletedExternalId],
    });

    expect(result).toMatchObject({
      id: PRODUCT_ID,
      shortcode: unsafeProductShortcode("P-TEST"),
      name: "Flour",
      manufacturer: "Generic",
      images: [
        { id: IMAGE_ID, url: "https://example.com/image.jpg" },
        { id: JOIN_IMAGE_ID, url: "https://example.com/joined.jpg" },
      ],
      externalIds: [{ id: EXTERNAL_ID, source: "amazon" }],
    });
    expect(result).not.toHaveProperty("deletedAt");
    expect(result).not.toHaveProperty("ingredientId");
    expect(result.images[0]).not.toHaveProperty("deletedAt");
    expect(result.externalIds[0]).not.toHaveProperty("deletedAt");
    expect(result.externalIds[0]).not.toHaveProperty("productId");
    expect(productTopLevelOut.parse(result)).toEqual(result);
  });

  it("maps picker rows directly without broad product fields", () => {
    const result = dbProductToPickerItemAPI(baseProduct);

    expect(result).toEqual({
      id: PRODUCT_ID,
      shortcode: unsafeProductShortcode("P-TEST"),
      name: "Flour",
      manufacturer: "Generic",
    });
    expect(result).not.toHaveProperty("price");
    expect(result).not.toHaveProperty("images");
    expect(productPickerItemOut.parse(result)).toEqual(result);
  });

  it("maps full product detail rows exactly", () => {
    const row = {
      ...baseProduct,
      ingredient: {
        id: INGREDIENT_ID,
        name: "Wheat flour",
        aliases: ["flour"],
        naKinds: [],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        deletedAt: DELETED_AT,
        recipeId: null,
      },
      unitMappings: [activeUnitMapping, deletedUnitMapping],
      externalIds: [activeExternalId, deletedExternalId],
      images: [
        { image: baseImage, deletedAt: null },
        { image: joinedImage, deletedAt: DELETED_AT },
      ],
      inventoryEntry: [
        {
          id: INVENTORY_ID,
          productId: PRODUCT_ID,
          amount: { value: 2, unit: "each" },
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          locationId: LOCATION_ID,
          valuation: 9,
          location: {
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
            images: [],
          },
        },
      ],
    } satisfies ProductDeepDB;

    const result = dbProductToAPI(row);

    expect(result).toMatchObject({
      id: PRODUCT_ID,
      shortcode: unsafeProductShortcode("P-TEST"),
      ingredient: {
        id: INGREDIENT_ID,
        name: "Wheat flour",
        aliases: ["flour"],
      },
      unitMappings: [
        {
          id: UNIT_MAPPING_ID,
          sourceMetadata: { type: "product", productId: PRODUCT_ID },
        },
      ],
      externalIds: [{ id: EXTERNAL_ID }],
      images: [{ id: IMAGE_ID }],
      inventoryEntry: [
        {
          id: INVENTORY_ID,
          amount: { value: 2, unit: "each" },
          location: {
            id: LOCATION_ID,
            shortcode: unsafeLocationShortcode("L-TEST"),
            name: "Pantry",
          },
        },
      ],
    });
    expect(result).not.toHaveProperty("deletedAt");
    expect(result.ingredient).not.toHaveProperty("deletedAt");
    expect(result.unitMappings).toHaveLength(1);
    expect(result.images).toHaveLength(1);
    expect(result.externalIds).toHaveLength(1);
    expect(result.inventoryEntry[0]).not.toHaveProperty("productId");
    expect(result.inventoryEntry[0]).not.toHaveProperty("locationId");
    expect(
      productWithIngredientAndInventoryAndMappingsOut.parse(result),
    ).toEqual(result);
  });
});
