import {
  unsafeIngredientId,
  unsafeIngredientShortcode,
  unsafeInventoryId,
  unsafeInventoryShortcode,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  productListItemOut,
  productTopLevelOut,
  productWithIngredientAndInventoryAndMappingsOut,
} from "@cubby/schemas/product";
import { describe, expect, it } from "vitest";
import {
  dbProductToAPI,
  dbProductToListAPI,
  dbProductToTopLevelAPI,
} from "./mappers";
import { EMPTY_QUANTITY_LEDGER } from "./quantity-ledger";
import type { ProductDeepDB, ProductListDB } from "./types";

const PRODUCT_ID = unsafeProductId("123e4567-e89b-12d3-a456-426614174000");
const INGREDIENT_ID = unsafeIngredientId(
  "223e4567-e89b-12d3-a456-426614174000",
);
const LOCATION_ID = unsafeLocationId("323e4567-e89b-12d3-a456-426614174000");
const INVENTORY_ID = unsafeInventoryId("423e4567-e89b-12d3-a456-426614174000");
const DELETED_LOCATION_INVENTORY_ID = unsafeInventoryId(
  "023e4567-e89b-12d3-a456-426614174000",
);
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

const baseProduct = {
  id: PRODUCT_ID,
  shortcode: "PRD-TEST",
  name: "Flour",
  manufacturer: "Generic",
  tags: [],
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
  stockTracked: null,
  expenseCount: 0,
  componentCount: 0,
  cookbookRecipeCount: 0,
  expenseTotal: 42.5,
  purchaseDate: null,
  quantityLedger: EMPTY_QUANTITY_LEDGER,
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

const activeLocation = {
  id: LOCATION_ID,
  shortcode: "LOC-TEST",
  name: "Pantry",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
  lastBulkInventory: null,
  productId: null,
  parentId: null,
  type: "room",
  aiDescription: null,
  valuation: null,
};

const deletedLocation = {
  ...activeLocation,
  id: unsafeLocationId("c23e4567-e89b-12d3-a456-426614174000"),
  shortcode: "LOC-9WK4",
  deletedAt: DELETED_AT,
};

describe("product mappers", () => {
  it("maps top-level products exactly and filters soft-deleted relations", () => {
    const result = dbProductToTopLevelAPI({
      ...baseProduct,
      dataQuality: completeDataQuality,
      images: [
        baseImage,
        deletedImage,
        { image: joinedImage, deletedAt: null },
        { image: baseImage, deletedAt: DELETED_AT },
      ],
      externalIds: [activeExternalId, deletedExternalId],
    });

    expect(result).toMatchObject({
      id: unsafeProductShortcode("PRD-TEST"),
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

  it("maps list rows to the list contract without full location payloads", () => {
    const row = {
      ...baseProduct,
      dataQuality: completeDataQuality,
      ingredient: {
        id: INGREDIENT_ID,
        shortcode: "ING-TEST",
        name: "Wheat flour",
        aliases: ["flour"],
        naKinds: [],
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        deletedAt: null,
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
          shortcode: "INV-2345",
          productId: PRODUCT_ID,
          amount: { value: 2, unit: "each" },
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          locationId: LOCATION_ID,
          valuation: 9,
          verifiedAt: null,
          placement: "stock" as const,
          location: activeLocation,
        },
        {
          id: DELETED_LOCATION_INVENTORY_ID,
          shortcode: "INV-3456",
          productId: PRODUCT_ID,
          amount: { value: 1, unit: "each" },
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          locationId: deletedLocation.id,
          valuation: 4.5,
          verifiedAt: null,
          placement: "stock" as const,
          location: deletedLocation,
        },
      ],
    } satisfies ProductListDB;

    const result = dbProductToListAPI(row);

    expect(result).toMatchObject({
      id: unsafeProductShortcode("PRD-TEST"),
      ingredient: {
        id: unsafeIngredientShortcode("ING-TEST"),
        name: "Wheat flour",
      },
      unitMappings: [
        {
          id: UNIT_MAPPING_ID,
          sourceMetadata: {
            type: "product",
            productId: unsafeProductShortcode("PRD-TEST"),
          },
        },
      ],
      externalIds: [{ id: EXTERNAL_ID }],
      images: [{ id: IMAGE_ID }],
      inventoryEntry: [
        {
          id: unsafeInventoryShortcode("INV-2345"),
          amount: { value: 2, unit: "each" },
          location: {
            id: unsafeLocationShortcode("LOC-TEST"),
            name: "Pantry",
            type: "room",
          },
        },
      ],
    });
    expect(result.inventoryEntry).toHaveLength(1);
    expect(result.inventoryEntry[0]?.location).not.toHaveProperty("images");
    expect(result.inventoryEntry[0]).not.toHaveProperty("productId");
    expect(result.inventoryEntry[0]).not.toHaveProperty("locationId");
    // Net basis rollup: a plain number, not the bigint-string union
    // expenseCount tolerates.
    expect(result.expenseTotal).toEqual(42.5);
    expect(productListItemOut.parse(result)).toEqual(result);
  });

  it("coerces expenseTotal the same way as expenseCount", () => {
    const row = {
      ...baseProduct,
      dataQuality: completeDataQuality,
      ingredient: null,
      unitMappings: [],
      externalIds: [],
      images: [],
      inventoryEntry: [],
      expenseCount: 3,
      expenseTotal: -12.75,
    } satisfies ProductListDB;

    const result = dbProductToListAPI(row);

    // A net-negative product (refunds/disposals outweighing acquisitions) is
    // real in this ledger and must survive the mapper untouched.
    expect(result.expenseTotal).toEqual(-12.75);
  });

  it("maps full product detail rows exactly", () => {
    const row = {
      ...baseProduct,
      ingredient: {
        id: INGREDIENT_ID,
        shortcode: "ING-TEST",
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
          shortcode: "INV-2345",
          productId: PRODUCT_ID,
          amount: { value: 2, unit: "each" },
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          locationId: LOCATION_ID,
          valuation: 9,
          verifiedAt: null,
          placement: "stock" as const,
          location: {
            ...activeLocation,
            deletedAt: null,
            images: [],
          },
        },
        {
          // Live entry, dead shelf. `dbProductToListAPI` has always dropped
          // this and `onHandUnitsSql` inner-joins live locations; the detail
          // mapper used to keep it, so one product reported different stock on
          // two surfaces.
          id: DELETED_LOCATION_INVENTORY_ID,
          shortcode: "INV-3456",
          productId: PRODUCT_ID,
          amount: { value: 1, unit: "each" },
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          locationId: deletedLocation.id,
          valuation: 4.5,
          verifiedAt: null,
          placement: "stock" as const,
          location: { ...deletedLocation, images: [] },
        },
      ],
    } satisfies ProductDeepDB;

    const dataQuality = {
      status: "needs_data" as const,
      gaps: [
        {
          check: "product_model" as const,
          facet: "identity" as const,
          kind: "missing" as const,
          targetType: "product" as const,
          targetId: unsafeProductShortcode("PRD-TEST"),
          message: "Manufacturer model is not recorded.",
        },
      ],
      facets: [
        {
          name: "identity" as const,
          status: "needs_data" as const,
          gaps: [
            {
              check: "product_model" as const,
              facet: "identity" as const,
              kind: "missing" as const,
              targetType: "product" as const,
              targetId: unsafeProductShortcode("PRD-TEST"),
              message: "Manufacturer model is not recorded.",
            },
          ],
        },
        { name: "provenance" as const, status: "complete" as const, gaps: [] },
        { name: "integrity" as const, status: "complete" as const, gaps: [] },
      ],
      exceptions: [],
      relatedGaps: [],
      relatedExceptions: [],
    };
    const result = dbProductToAPI(row, dataQuality);

    expect(result).toMatchObject({
      id: unsafeProductShortcode("PRD-TEST"),
      ingredient: {
        id: unsafeIngredientShortcode("ING-TEST"),
        name: "Wheat flour",
        aliases: ["flour"],
      },
      unitMappings: [
        {
          id: UNIT_MAPPING_ID,
          sourceMetadata: {
            type: "product",
            productId: unsafeProductShortcode("PRD-TEST"),
          },
        },
      ],
      externalIds: [{ id: EXTERNAL_ID }],
      images: [{ id: IMAGE_ID }],
      dataQuality,
      inventoryEntry: [
        {
          id: unsafeInventoryShortcode("INV-2345"),
          amount: { value: 2, unit: "each" },
          location: {
            id: unsafeLocationShortcode("LOC-TEST"),
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
    // The dead-shelf entry is gone, matching `dbProductToListAPI`.
    expect(result.inventoryEntry).toHaveLength(1);
    expect(
      productWithIngredientAndInventoryAndMappingsOut.parse(result),
    ).toEqual(result);
  });
});

/**
 * On-hand is the UNION of stock and identity: inventory units plus the
 * Locations that ARE this product. The SQL half of the same rule lives in
 * `onHandUnitsSql`; these two must agree.
 */
describe("on-hand counts units in service as locations", () => {
  const stockedRow = (locationCount: number, entryValue: number | null) =>
    ({
      ...baseProduct,
      quantityLedger: {
        ...EMPTY_QUANTITY_LEDGER,
        acquiredUnits: 3,
        expectedQuantity: 3,
        locationCount,
      },
      ingredient: null,
      dataQuality: completeDataQuality,
      unitMappings: [],
      externalIds: [],
      images: [],
      inventoryEntry:
        entryValue === null
          ? []
          : [
              {
                id: INVENTORY_ID,
                shortcode: "INV-2345",
                productId: PRODUCT_ID,
                amount: { value: entryValue, unit: "each" },
                createdAt: CREATED_AT,
                updatedAt: UPDATED_AT,
                deletedAt: null,
                locationId: LOCATION_ID,
                valuation: 9,
                verifiedAt: null,
                placement: "stock" as const,
                location: activeLocation,
              },
            ],
    }) satisfies ProductListDB;

  it("sums loose stock and in-use locations against the ledger", () => {
    // One packout loose on a shelf, two in service as bins, three bought.
    const result = dbProductToListAPI(stockedRow(2, 1));
    expect(result.onHandUnits).toBe(3);
    expect(result.quantityVariance).toBe(0);
  });

  it("counts locations even when nothing is on a shelf", () => {
    // The whole point: without this the containers read as missing and every
    // one of them lights "Shelf disagrees" forever.
    const result = dbProductToListAPI(stockedRow(3, null));
    expect(result.onHandUnits).toBe(3);
    expect(result.quantityVariance).toBe(0);
  });

  it("stays null when there is neither stock nor a location", () => {
    const result = dbProductToListAPI(stockedRow(0, null));
    expect(result.onHandUnits).toBeNull();
    expect(result.quantityVariance).toBeNull();
  });
});
