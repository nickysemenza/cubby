import { testCompleteDataQuality, testEntityId } from "@cubby/schemas/testing";
import { productRowFixture } from "tooling/product-category-fixtures";
import { describe, expect, it } from "vitest";

import { deriveProductQuantitySummary } from "~/server/lib/product-quantity-summary";

import { mapProductListInventoryEntries } from "./mappers";
import { EMPTY_QUANTITY_LEDGER } from "./quantity-ledger";
import type { ProductListDB } from "./types";

const PRODUCT_ID = testEntityId(
  "product",
  "123e4567-e89b-12d3-a456-426614174000",
);
const INGREDIENT_ID = testEntityId(
  "ingredient",
  "223e4567-e89b-12d3-a456-426614174000",
);
const LOCATION_ID = testEntityId(
  "location",
  "323e4567-e89b-12d3-a456-426614174000",
);
const INVENTORY_ID = testEntityId(
  "inventory",
  "423e4567-e89b-12d3-a456-426614174000",
);
const CREATED_AT = new Date("2024-01-01T00:00:00.000Z");
const UPDATED_AT = new Date("2024-01-02T00:00:00.000Z");
const DELETED_AT = new Date("2024-01-03T00:00:00.000Z");

// A real (not hardcoded-complete-footgun) computed quality: the mapper no
// longer has a fallback for this field, so every fixture below supplies one
// explicitly, same as a real caller must.
const completeDataQuality = {
  status: "complete" as const,
  score: 100,
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
  ...productRowFixture({
    id: PRODUCT_ID,
    upc: "012345678905",
    model: "5lb",
    notes: "Keep dry",
    deletedAt: DELETED_AT,
    ingredientId: INGREDIENT_ID,
  }),
  expenseCount: 0,
  componentCount: 0,
  expenseTotal: 42.5,
  purchaseDate: null,
  quantityLedger: EMPTY_QUANTITY_LEDGER,
};

const activeLocation = {
  id: LOCATION_ID,
  shortcode: "LOC-TEST",
  name: "Pantry",
  aliases: [],
  tags: [],
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
  lastBulkInventory: null,
  productId: null,
  parentId: null,
  type: "room",
  notes: null,
  aiDescription: null,
  valuation: null,
  dataQuality: testCompleteDataQuality(),
};

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
                amountValue: entryValue,
                amountUnit: "each",
                createdAt: CREATED_AT,
                updatedAt: UPDATED_AT,
                deletedAt: null,
                locationId: LOCATION_ID,
                valuation: 9,
                verifiedAt: null,
                placement: "stock" as const,
                ownershipMode: "inherit" as const,
                ownerLedgerPartyId: null,
                location: activeLocation,
              },
            ],
    }) satisfies ProductListDB;

  it.each([
    {
      name: "sums loose stock and in-use locations against the ledger",
      locationCount: 2,
      entryValue: 1,
      onHandUnits: 3,
      quantityVariance: 0,
    },
    {
      name: "counts locations even when nothing is on a shelf",
      locationCount: 3,
      entryValue: null,
      onHandUnits: 3,
      quantityVariance: 0,
    },
    {
      name: "stays null when there is neither stock nor a location",
      locationCount: 0,
      entryValue: null,
      onHandUnits: null,
      quantityVariance: null,
    },
  ])(
    "$name",
    ({ locationCount, entryValue, onHandUnits, quantityVariance }) => {
      const row = stockedRow(locationCount, entryValue);
      const result = deriveProductQuantitySummary(
        mapProductListInventoryEntries(row.inventoryEntry),
        row.quantityLedger,
        false,
      );
      expect(result.onHandUnits).toBe(onHandUnits);
      expect(result.quantityVariance).toBe(quantityVariance);
    },
  );
});
