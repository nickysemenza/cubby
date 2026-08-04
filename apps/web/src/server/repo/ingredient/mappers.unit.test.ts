import {
  unsafeIngredientId,
  unsafeIngredientShortcode,
  unsafeProductId,
  unsafeProductShortcode,
  unsafeRecipeId,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import {
  ingredientOut,
  ingredientWithRecipesAndProductOut,
} from "@cubby/schemas/ingredient";
import { productWithMappingsOut } from "@cubby/schemas/product";
import { describe, expect, it } from "vitest";
import {
  dbIngredientToAPI,
  dbIngredientToTopLevelShape,
  type IngredientDeepDB,
  mapIngredientProducts,
  mapIngredientProductsLean,
  type Qualified,
} from "./internal-types";

const PRODUCT_ID = unsafeProductId("123e4567-e89b-12d3-a456-426614174000");
const INGREDIENT_ID = unsafeIngredientId(
  "223e4567-e89b-12d3-a456-426614174000",
);
const RECIPE_ID = unsafeRecipeId("923e4567-e89b-12d3-a456-426614174000");
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
  shortcode: "PRD-TEST",
  name: "Flour",
  manufacturer: "Generic",
  tags: [],
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

const baseIngredient = {
  id: INGREDIENT_ID,
  shortcode: "ING-TEST",
  name: "Wheat flour",
  aliases: ["flour"],
  naKinds: [],
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  recipeId: null,
};

const baseRecipe = {
  id: RECIPE_ID,
  shortcode: "RCP-TEST",
  name: "Pancakes",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  SourceType: "Website" as const,
  SourceData: "https://example.com/pancakes",
  cookbookId: null,
  yield: null,
  servings: null,
  tags: null,
  notes: null,
  totals: null,
  totalsComputedAt: null,
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

// A real (not hardcoded-complete-footgun) computed quality: the mapper no
// longer has a fallback for this field, so every fixture below supplies one
// explicitly, same as a real caller must.
const completeDataQuality = {
  status: "complete" as const,
  facets: [
    { name: "identity" as const, status: "complete" as const, gaps: [] },
    { name: "provenance" as const, status: "complete" as const, gaps: [] },
    { name: "integrity" as const, status: "complete" as const, gaps: [] },
  ],
  gaps: [],
  exceptions: [],
  relatedGaps: [],
  relatedExceptions: [],
};

const firstResult = <T>(items: T[]): T => {
  const item = items[0];
  if (!item) throw new Error("Expected mapper fixture to return one item");
  return item;
};

describe("ingredient product mappers", () => {
  it("maps ingredient scalar rows without DB-only fields", () => {
    const result = dbIngredientToTopLevelShape(baseIngredient);

    expect(result).toEqual({
      id: unsafeIngredientShortcode("ING-TEST"),
      name: "Wheat flour",
      aliases: ["flour"],
      naKinds: [],
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    expect(result).not.toHaveProperty("deletedAt");
    expect(result).not.toHaveProperty("recipeId");
    expect(ingredientOut.parse(result)).toEqual(result);
  });

  it("maps full ingredient products exactly and filters soft-deleted relations", () => {
    const rows = [
      {
        ...baseProduct,
        dataQuality: completeDataQuality,
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
    ] satisfies Array<Qualified<IngredientDeepDB["product"][number]>>;

    const result = firstResult(mapIngredientProducts(rows));

    expect(result).toMatchObject({
      id: unsafeProductShortcode("PRD-TEST"),
      images: [{ id: IMAGE_ID }],
      externalIds: [{ id: EXTERNAL_ID }],
      unitMappings: [
        {
          id: UNIT_MAPPING_ID,
          sourceMetadata: {
            type: "product",
            productId: unsafeProductShortcode("PRD-TEST"),
          },
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
          pricing: {
            derivedPrice: null,
            effectivePrice: baseProduct.price,
            source: "explicit",
            knownExpenseCount: 0,
            unknownExpenseCount: 0,
            knownUnitCount: 0,
            partial: false,
          },
          dataQuality: completeDataQuality,
          unitMappings: [activeUnitMapping],
        },
      ]),
    );

    expect(result).toMatchObject({
      id: unsafeProductShortcode("PRD-TEST"),
      images: [],
      externalIds: [],
      unitMappings: [{ id: UNIT_MAPPING_ID }],
    });
    expect(productWithMappingsOut.parse(result)).toEqual(result);
  });

  it("maps full ingredient rows without leaking DB-only recipe fields", async () => {
    const liveRecipe = { ...baseRecipe, deletedAt: null };
    const result = await dbIngredientToAPI({} as never, {
      ...baseIngredient,
      recipe: liveRecipe,
      product: [
        {
          ...baseProduct,
          pricing: {
            derivedPrice: null,
            effectivePrice: baseProduct.price,
            source: "explicit",
            knownExpenseCount: 0,
            unknownExpenseCount: 0,
            knownUnitCount: 0,
            partial: false,
          },
          dataQuality: completeDataQuality,
          unitMappings: [activeUnitMapping],
          externalIds: [],
          images: [],
        },
      ],
      recipeSectionIngredient: [
        {
          id: "b23e4567-e89b-12d3-a456-426614174000",
          recipeSectionId: "c23e4567-e89b-12d3-a456-426614174000",
          ingredientId: INGREDIENT_ID,
          amounts: [{ value: 1, unit: "cup" }],
          rawLine: "1 cup flour",
          modifier: null,
          sortOrder: 0,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          recipeSection: {
            id: "c23e4567-e89b-12d3-a456-426614174000",
            recipeId: RECIPE_ID,
            name: "Batter",
            instructions: [],
            sortOrder: 0,
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            deletedAt: null,
            recipe: liveRecipe,
          },
        },
      ],
    } satisfies IngredientDeepDB);

    expect(result.recipe).toMatchObject({
      id: unsafeRecipeShortcode("RCP-TEST"),
      name: "Pancakes",
    });
    expect(result.recipe).not.toHaveProperty("shortcode");
    expect(result.recipe).not.toHaveProperty("totals");
    expect(result.recipeUsages[0]?.recipe).not.toHaveProperty("totals");
    expect(result).not.toHaveProperty("deletedAt");
    expect(result).not.toHaveProperty("recipeId");
    expect(ingredientWithRecipesAndProductOut.parse(result)).toEqual(result);
  });
});
