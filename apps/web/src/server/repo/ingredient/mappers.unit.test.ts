import {
  unsafeIngredientId,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { productWithMappingsOut } from "@cubby/schemas/product-responses";
import { describe, expect, it } from "vitest";
import {
  type IngredientDeepDB,
  mapIngredientProducts,
  mapIngredientProductsLean,
} from "./internal-types";

const PRODUCT_ID = unsafeProductId("123e4567-e89b-12d3-a456-426614174000");
const INGREDIENT_ID = unsafeIngredientId(
  "223e4567-e89b-12d3-a456-426614174000",
);
const IMAGE_ID = "323e4567-e89b-12d3-a456-426614174000";
const DELETED_IMAGE_ID = "423e4567-e89b-12d3-a456-426614174000";
const EXTERNAL_ID = "523e4567-e89b-12d3-a456-426614174000";
const DELETED_EXTERNAL_ID = "623e4567-e89b-12d3-a456-426614174000";
const UNIT_MAPPING_ID = "723e4567-e89b-12d3-a456-426614174000";
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
  model: null,
  notes: null,
  expectedQuantity: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
  ingredientId: INGREDIENT_ID,
  category: "food" as const,
  price: 4.5,
  usdaUnavailable: null,
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

const firstResult = <T>(items: T[]): T => {
  const item = items[0];
  if (!item) throw new Error("Expected mapper fixture to return one item");
  return item;
};

describe("ingredient product mappers", () => {
  it("maps full ingredient products exactly and filters soft-deleted relations", () => {
    const rows = [
      {
        ...baseProduct,
        unitMappings: [activeUnitMapping, deletedUnitMapping],
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
              deletedAt: null,
            },
            deletedAt: null,
          },
          {
            image: {
              id: DELETED_IMAGE_ID,
              url: "https://example.com/deleted.jpg",
              key: "deleted.jpg",
              filename: "deleted.jpg",
              size: 100,
              contentType: "image/jpeg",
              status: "UPLOADED" as const,
              createdAt: CREATED_AT,
              updatedAt: UPDATED_AT,
              deletedAt: null,
            },
            deletedAt: DELETED_AT,
          },
        ],
      },
    ] satisfies IngredientDeepDB["product"];

    const result = firstResult(mapIngredientProducts(rows));

    expect(result).toMatchObject({
      id: PRODUCT_ID,
      shortcode: unsafeProductShortcode("P-TEST"),
      images: [{ id: IMAGE_ID }],
      externalIds: [{ id: EXTERNAL_ID }],
      unitMappings: [
        {
          id: UNIT_MAPPING_ID,
          sourceMetadata: { type: "product", productId: PRODUCT_ID },
        },
      ],
    });
    expect(result).not.toHaveProperty("deletedAt");
    expect(result).not.toHaveProperty("ingredientId");
    expect(result.images).toHaveLength(1);
    expect(result.externalIds).toHaveLength(1);
    expect(result.unitMappings).toHaveLength(1);
    expect(productWithMappingsOut.parse(result)).toEqual(result);
  });

  it("maps lean ingredient products with empty ancillary arrays", () => {
    const result = firstResult(
      mapIngredientProductsLean([
        {
          ...baseProduct,
          unitMappings: [activeUnitMapping],
        },
      ]),
    );

    expect(result).toMatchObject({
      id: PRODUCT_ID,
      images: [],
      externalIds: [],
      unitMappings: [{ id: UNIT_MAPPING_ID }],
    });
    expect(productWithMappingsOut.parse(result)).toEqual(result);
  });
});
