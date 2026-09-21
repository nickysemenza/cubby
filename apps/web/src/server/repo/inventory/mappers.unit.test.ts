import { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
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

import { resolveProductPricing } from "../product/pricing";
import { dbInventoryEntryToAPI } from "./mappers";
import type { InventoryEntryDeepDB } from "./types";

const INVENTORY_ID = testEntityId(
  "inventory",
  "123e4567-e89b-12d3-a456-426614174000",
);
const PRODUCT_ID = testEntityId(
  "product",
  "223e4567-e89b-12d3-a456-426614174000",
);
const LOCATION_ID = testEntityId(
  "location",
  "323e4567-e89b-12d3-a456-426614174000",
);
const IMAGE_SHORTCODE = "IMG-2345";
const EXTERNAL_ID = "523e4567-e89b-12d3-a456-426614174000";
const UNIT_MAPPING_ID = "623e4567-e89b-12d3-a456-426614174000";
const DELETED_EXTERNAL_ID = "723e4567-e89b-12d3-a456-426614174000";
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
  growsIngredientId: null,
  model: "5lb",
  expectedQuantity: null,
  notes: "Keep dry",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  ingredientId: null,
  categoryId: taxonomyId("food"),
  category: categorySummaryFixture("food"),
  price: 4.5,
  usdaUnavailable: null,
  stockTracked: null,
  labelNutrition: null,
};

const baseLocation = {
  id: LOCATION_ID,
  shortcode: "LOC-TEST",
  name: "Pantry",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  lastBulkInventory: null,
  productId: null,
  parentId: null,
  type: "room",
  aiDescription: null,
  notes: null,
  valuation: null,
};

const baseInventoryEntry = {
  id: INVENTORY_ID,
  shortcode: "INV-TEST",
  productId: PRODUCT_ID,
  amount: { value: 2, unit: "each" },
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  locationId: LOCATION_ID,
  valuation: 9,
  verifiedAt: null,
  placement: "stock" as const,
  ownershipMode: "inherit" as const,
  ownerLedgerPartyId: null,
};

describe("inventory mappers", () => {
  it("uses authoritative product pricing instead of reversing rounded valuation", () => {
    const row = {
      ...baseInventoryEntry,
      amount: { value: 1.3, unit: "each" },
      valuation: 8.87,
      product: {
        ...baseProduct,
        price: null,
        unitMappings: [],
        externalIds: [],
        images: [],
      },
      location: { ...baseLocation, images: [] },
    } satisfies InventoryEntryDeepDB;

    const result = dbInventoryEntryToAPI(
      row,
      resolveProductPricing(null, {
        knownCost: 6.83,
        knownExpenseCount: 1,
        unknownExpenseCount: 0,
        knownUnitCount: 1,
      }),
      testCompleteDataQuality(),
      testCompleteDataQuality(),
    );

    // 8.87 / 1.3 rounds to 6.82; the product's authoritative effective
    // price is $6.83 and must survive the inventory valuation's cent rounding.
    expect(result.product.price).toEqual(6.83);
  });

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
              shortcode: IMAGE_SHORTCODE,
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

    const locationDataQuality = testCompleteDataQuality();
    const result = dbInventoryEntryToAPI(
      row,
      resolveProductPricing(4.5),
      testCompleteDataQuality(),
      locationDataQuality,
    );

    expect(result).toEqual({
      id: testShortcode("inventory", "INV-TEST"),
      amount: { value: 2, unit: "each" },
      valuation: 9,
      verifiedAt: null,
      placement: "stock" as const,
      ownershipMode: "inherit" as const,
      ownerLedgerPartyId: null,
      effectiveOwnership: {
        mode: "inherit",
        explicitOwner: null,
        effectiveOwner: null,
        source: "unresolved",
        basis: null,
        evidence: null,
        evidenceFingerprint: "unresolved",
        matchesInheritedOwner: false,
      },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      dataQuality: testCompleteDataQuality(),
      location: {
        id: testShortcode("location", "LOC-TEST"),
        aliases: [],
        lastBulkInventory: null,
        product: null,
        aiDescription: null,
        notes: null,
        images: [],
        valuation: null,
        name: "Pantry",
        type: "room",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        dataQuality: locationDataQuality,
      },
      product: {
        id: testShortcode("product", "PRD-TEST"),
        images: [],
        externalIds: [
          {
            id: EXTERNAL_ID,
            source: "amazon",
            kind: "legacy_unspecified",
            externalId: "B000000001",
            url: "https://example.com/product",
            // Rows written before the column existed default to primary — back
            // then a slot held exactly one row.
            isPrimary: true,
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
          },
        ],
        price: 4.5,
        usdaUnavailable: null,
        name: "Flour",
        primaryGtin: null,
        fdc_id: null,
        manufacturer: "Generic",
        model: "5lb",
        notes: "Keep dry",
        expectedQuantity: null,
        category: categorySummaryFixture("food"),
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
              productId: testShortcode("product", "PRD-TEST"),
            },
          },
        ],
      },
      displayName: "Flour · Pantry",
    });
    expect(inventoryWithLocationAndProductOut.parse(result)).toEqual(result);
  });
});
