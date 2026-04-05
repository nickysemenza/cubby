/**
 * Unit tests for processRowInMemory
 *
 * Tests the in-memory row processor that determines actions and generates
 * write operations without making database queries.
 */

import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ProductTopLevelOut } from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import type {
  InventoryLookupMap,
  LocationLookupMap,
  ProductLookupMap,
} from "~/server/repo/database-helpers";
import { createProductKey } from "~/server/repo/database-helpers";
import { processRowInMemory } from "./row-processor-inmemory";

// Type for lookup maps
interface LookupMaps {
  productMap: ProductLookupMap;
  locationMap: LocationLookupMap;
  inventoryMap: InventoryLookupMap;
  ingredientMap: Map<string, string>;
}

/**
 * Helper to create empty lookup maps
 */
function createMockLookups(overrides?: Partial<LookupMaps>): LookupMaps {
  return {
    productMap: new Map(),
    locationMap: new Map(),
    inventoryMap: new Map(),
    ingredientMap: new Map(),
    ...overrides,
  };
}

/**
 * Helper to create a fixture product
 */
function createFixtureProduct(
  overrides?: Partial<ProductTopLevelOut>,
): ProductTopLevelOut {
  return {
    id: unsafeProductId(`prod-${Math.random().toString(36).slice(2)}`),
    shortcode: unsafeProductShortcode("TEST"),
    name: "Test Product",
    manufacturer: "Test Brand",
    model: null,
    category: null,
    notes: null,
    expectedQuantity: null,
    price: null,
    upc: null,
    ndb_number: null,
    images: [],
    externalIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("processRowInMemory", () => {
  describe("Product Resolution", () => {
    it("should find existing product by name + manufacturer", () => {
      const productMap = new Map();
      const key = createProductKey("Flour", "Bob's Red Mill");
      productMap.set(
        key,
        createFixtureProduct({
          id: unsafeProductId("prod-1"),
          name: "Flour",
          manufacturer: "Bob's Red Mill",
        }),
      );

      const lookups = createMockLookups({ productMap });
      const row = {
        product_name: "Flour",
        manufacturer: "Bob's Red Mill",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.productId).toBe("prod-1");
      expect(result.productToCreate).toBeUndefined();
    });

    it("should create new product when not found", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "Sugar",
        manufacturer: "Brand",
        quantity: 3,
        unit: "lbs",
        location_name: "Pantry",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.productWillBeCreated).toBe(true);
      expect(result.productToCreate).toMatchObject({
        name: "Sugar",
        manufacturer: "Brand",
      });
    });

    it("should default null manufacturer to UNSPECIFIED_MANUFACTURER", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "Salt",
        manufacturer: undefined,
        quantity: 1,
        unit: "each",
        location_name: "Kitchen",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.productToCreate?.manufacturer).toBe(
        UNSPECIFIED_MANUFACTURER,
      );
    });

    it("should handle undefined manufacturer as UNSPECIFIED_MANUFACTURER", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "Pepper",
        manufacturer: undefined,
        quantity: 1,
        unit: "each",
        location_name: "Kitchen",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.productToCreate?.manufacturer).toBe(
        UNSPECIFIED_MANUFACTURER,
      );
    });

    it("should match product case-insensitively", () => {
      const productMap = new Map();
      // Product stored with mixed case
      const key = createProductKey("All-Purpose Flour", "King Arthur");
      productMap.set(
        key,
        createFixtureProduct({
          id: unsafeProductId("prod-1"),
          name: "All-Purpose Flour",
          manufacturer: "King Arthur",
        }),
      );

      const lookups = createMockLookups({ productMap });
      const row = {
        product_name: "All-Purpose Flour", // Same case
        manufacturer: "King Arthur",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.productId).toBe("prod-1");
      expect(result.productToCreate).toBeUndefined();
    });

    it("should distinguish products by manufacturer", () => {
      const productMap = new Map();
      const keyBrand1 = createProductKey("Flour", "Brand A");
      const keyBrand2 = createProductKey("Flour", "Brand B");
      productMap.set(
        keyBrand1,
        createFixtureProduct({
          id: unsafeProductId("prod-1"),
          name: "Flour",
          manufacturer: "Brand A",
        }),
      );
      productMap.set(
        keyBrand2,
        createFixtureProduct({
          id: unsafeProductId("prod-2"),
          name: "Flour",
          manufacturer: "Brand B",
        }),
      );

      const lookups = createMockLookups({ productMap });
      const row = {
        product_name: "Flour",
        manufacturer: "Brand B",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      // Should match Brand B, not Brand A
      expect(result.item.productId).toBe("prod-2");
    });
  });

  describe("Location Resolution", () => {
    it("should prioritize shortcode over name", () => {
      const locationMap = new Map();
      locationMap.set("pantry", unsafeLocationId("loc-name"));
      locationMap.set("shortcode:PAN", unsafeLocationId("loc-shortcode"));

      const lookups = createMockLookups({ locationMap });
      const row = {
        product_name: "Flour",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry",
        location_shortcode: "PAN",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      // Should use shortcode location, not name location
      expect(result.item.locationId).toBe("loc-shortcode");
    });

    it("should fall back to name when no shortcode", () => {
      const locationMap = new Map();
      locationMap.set("kitchen", unsafeLocationId("loc-1"));

      const lookups = createMockLookups({ locationMap });
      const row = {
        product_name: "Flour",
        quantity: 5,
        unit: "lbs",
        location_name: "Kitchen",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.locationId).toBe("loc-1");
    });

    it("should flag location not found", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "Flour",
        quantity: 5,
        unit: "lbs",
        location_name: "NonExistent",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.locationNotFound).toBe(true);
      expect(result.locationToAutoCreate).toMatchObject({
        name: "NonExistent",
      });
    });

    it("should normalize location name to lowercase", () => {
      const locationMap = new Map();
      // Stored as lowercase
      locationMap.set("kitchen", unsafeLocationId("loc-1"));

      const lookups = createMockLookups({ locationMap });
      const row = {
        product_name: "Flour",
        quantity: 5,
        unit: "lbs",
        location_name: "KITCHEN", // Uppercase input
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.locationId).toBe("loc-1");
    });

    it("should normalize location shortcode to uppercase", () => {
      const locationMap = new Map();
      // Stored with uppercase prefix
      locationMap.set("shortcode:PAN", unsafeLocationId("loc-1"));

      const lookups = createMockLookups({ locationMap });
      const row = {
        product_name: "Flour",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry",
        location_shortcode: "pan", // Lowercase input
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.locationId).toBe("loc-1");
    });
  });

  describe("Action Classification", () => {
    it("should return 'created' for new product at new location", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "NewProduct",
        quantity: 1,
        unit: "each",
        location_name: "Pantry",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("created");
    });

    it("should return 'updated' when amount changes", () => {
      const productId = unsafeProductId("prod-1");
      const locationId = unsafeLocationId("loc-1");

      const productMap = new Map();
      productMap.set(
        createProductKey("Flour", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Flour",
          manufacturer: "Brand",
        }),
      );

      const locationMap = new Map();
      locationMap.set("pantry", locationId);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${locationId}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId,
        amount: { value: 5, unit: "lbs" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Flour",
        manufacturer: "Brand",
        quantity: 8, // different amount
        unit: "lbs",
        location_name: "Pantry",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("updated");
    });

    it("should return 'skipped' when amount matches exactly", () => {
      const productId = unsafeProductId("prod-1");
      const locationId = unsafeLocationId("loc-1");

      const productMap = new Map();
      productMap.set(
        createProductKey("Salt", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Salt",
          manufacturer: "Brand",
        }),
      );

      const locationMap = new Map();
      locationMap.set("kitchen", locationId);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${locationId}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId,
        amount: { value: 10, unit: "each" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Salt",
        manufacturer: "Brand",
        quantity: 10, // same amount
        unit: "each",
        location_name: "Kitchen",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("skipped");
      expect(result.inventoryToUpsert).toBeUndefined(); // should NOT write
    });

    it("should return 'moved' for expectedQty=1 at different location", () => {
      const productId = unsafeProductId("prod-1");
      const oldLocationId = unsafeLocationId("loc-old");
      const newLocationId = unsafeLocationId("loc-new");

      const productMap = new Map();
      productMap.set(
        createProductKey("iPhone", "Apple"),
        createFixtureProduct({
          id: productId,
          name: "iPhone",
          manufacturer: "Apple",
          expectedQuantity: 1,
        }),
      );

      const locationMap = new Map();
      locationMap.set("drawer a", oldLocationId);
      locationMap.set("drawer b", newLocationId);

      const inventoryMap = new Map();
      // Currently at Drawer A
      inventoryMap.set(`${productId}|${oldLocationId}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId: oldLocationId,
        amount: { value: 1, unit: "each" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "iPhone",
        manufacturer: "Apple",
        expected_qty: 1,
        quantity: 1,
        unit: "each",
        location_name: "Drawer B", // different location
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("moved");
    });

    it("should return 'product_only' when no location provided", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "VanillaExtract",
        quantity: 1,
        unit: "each",
        location_name: undefined, // no location
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("product_only");
      expect(result.inventoryToUpsert).toBeUndefined();
      expect(result.productToCreate).toBeDefined();
    });

    it("should return 'created' for existing product at new location", () => {
      const productId = unsafeProductId("prod-1");
      const loc1 = unsafeLocationId("loc-1");
      const loc2 = unsafeLocationId("loc-2");

      const productMap = new Map();
      productMap.set(
        createProductKey("Flour", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Flour",
          manufacturer: "Brand",
        }),
      );

      const locationMap = new Map();
      locationMap.set("pantry a", loc1);
      locationMap.set("pantry b", loc2);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${loc1}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId: loc1,
        amount: { value: 5, unit: "lbs" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Flour",
        manufacturer: "Brand",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry B", // new location
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("created");
    });

    it("should return 'product_only' when location_name is empty string", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "Extract",
        quantity: 1,
        unit: "each",
        location_name: "", // empty string
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("product_only");
      expect(result.inventoryToUpsert).toBeUndefined();
    });
  });

  describe("Move Detection", () => {
    it("should NOT move when product at multiple locations", () => {
      const productId = unsafeProductId("prod-1");
      const loc1 = unsafeLocationId("loc-1");
      const loc2 = unsafeLocationId("loc-2");
      const loc3 = unsafeLocationId("loc-3");

      const productMap = new Map();
      productMap.set(
        createProductKey("Multi", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Multi",
          manufacturer: "Brand",
          expectedQuantity: 1,
        }),
      );

      const locationMap = new Map();
      locationMap.set("location 1", loc1);
      locationMap.set("location 2", loc2);
      locationMap.set("location 3", loc3);

      const inventoryMap = new Map();
      // Product exists at two locations
      inventoryMap.set(`${productId}|${loc1}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId: loc1,
        amount: { value: 1, unit: "each" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      inventoryMap.set(`${productId}|${loc2}`, {
        id: unsafeInventoryId("inv-2"),
        productId,
        locationId: loc2,
        amount: { value: 1, unit: "each" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Multi",
        manufacturer: "Brand",
        expected_qty: 1,
        quantity: 1,
        unit: "each",
        location_name: "Location 3",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      // Should NOT be "moved" because ambiguous (multiple locations)
      expect(result.item.action).not.toBe("moved");
      expect(result.item.action).toBe("created");
    });

    it("should NOT move when expectedQty != 1", () => {
      const productId = unsafeProductId("prod-1");
      const oldLoc = unsafeLocationId("loc-old");
      const newLoc = unsafeLocationId("loc-new");

      const productMap = new Map();
      productMap.set(
        createProductKey("Flour", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Flour",
          manufacturer: "Brand",
          expectedQuantity: 10,
        }),
      );

      const locationMap = new Map();
      locationMap.set("pantry a", oldLoc);
      locationMap.set("pantry b", newLoc);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${oldLoc}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId: oldLoc,
        amount: { value: 5, unit: "lbs" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Flour",
        manufacturer: "Brand",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry B",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).not.toBe("moved");
    });

    it("should NOT move when expectedQty=1 but already at target location", () => {
      const productId = unsafeProductId("prod-1");
      const locationId = unsafeLocationId("loc-1");

      const productMap = new Map();
      productMap.set(
        createProductKey("Phone", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Phone",
          manufacturer: "Brand",
          expectedQuantity: 1,
        }),
      );

      const locationMap = new Map();
      locationMap.set("drawer", locationId);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${locationId}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId,
        amount: { value: 1, unit: "each" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Phone",
        manufacturer: "Brand",
        expected_qty: 1,
        quantity: 1,
        unit: "each",
        location_name: "Drawer", // same location
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).not.toBe("moved");
      expect(result.item.action).toBe("skipped"); // amount matches too
    });

    it("should move when expectedQty=1, different amount at target location", () => {
      const productId = unsafeProductId("prod-1");
      const oldLocationId = unsafeLocationId("loc-old");
      const newLocationId = unsafeLocationId("loc-new");

      const productMap = new Map();
      productMap.set(
        createProductKey("Tablet", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Tablet",
          manufacturer: "Brand",
          expectedQuantity: 1,
        }),
      );

      const locationMap = new Map();
      locationMap.set("drawer a", oldLocationId);
      locationMap.set("drawer b", newLocationId);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${oldLocationId}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId: oldLocationId,
        amount: { value: 1, unit: "each" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Tablet",
        manufacturer: "Brand",
        expected_qty: 1,
        quantity: 2, // different amount
        unit: "each",
        location_name: "Drawer B",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      // Even though amount differs, it's still a "move" because expectedQty=1
      expect(result.item.action).toBe("moved");
    });
  });

  describe("Skip Detection", () => {
    it("should skip when value AND unit match exactly", () => {
      const productId = unsafeProductId("prod-1");
      const locationId = unsafeLocationId("loc-1");

      const productMap = new Map();
      productMap.set(
        createProductKey("Sugar", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Sugar",
          manufacturer: "Brand",
        }),
      );

      const locationMap = new Map();
      locationMap.set("pantry", locationId);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${locationId}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId,
        amount: { value: 5, unit: "lbs" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Sugar",
        manufacturer: "Brand",
        quantity: 5,
        unit: "lbs",
        location_name: "Pantry",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("skipped");
      expect(result.inventoryToUpsert).toBeUndefined();
    });

    it("should update when unit differs", () => {
      const productId = unsafeProductId("prod-1");
      const locationId = unsafeLocationId("loc-1");

      const productMap = new Map();
      productMap.set(
        createProductKey("Water", "Brand"),
        createFixtureProduct({
          id: productId,
          name: "Water",
          manufacturer: "Brand",
        }),
      );

      const locationMap = new Map();
      locationMap.set("fridge", locationId);

      const inventoryMap = new Map();
      inventoryMap.set(`${productId}|${locationId}`, {
        id: unsafeInventoryId("inv-1"),
        productId,
        locationId,
        amount: { value: 2, unit: "liters" },
        valuation: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const lookups = createMockLookups({
        productMap,
        locationMap,
        inventoryMap,
      });
      const row = {
        product_name: "Water",
        manufacturer: "Brand",
        quantity: 2, // same value
        unit: "gallons", // different unit
        location_name: "Fridge",
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("updated");
      expect(result.inventoryToUpsert).toBeDefined();
    });
  });

  describe("Product-Only Rows", () => {
    it("should handle product-only with existing product", () => {
      const productMap = new Map();
      productMap.set(
        createProductKey("Existing", "Brand"),
        createFixtureProduct({
          id: unsafeProductId("prod-1"),
          name: "Existing",
          manufacturer: "Brand",
        }),
      );

      const lookups = createMockLookups({ productMap });
      const row = {
        product_name: "Existing",
        manufacturer: "Brand",
        quantity: 1,
        unit: "each",
        location_name: "", // empty = product-only
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("product_only");
      expect(result.item.productId).toBe("prod-1");
      expect(result.productToCreate).toBeUndefined();
    });

    it("should handle product-only with new product", () => {
      const lookups = createMockLookups();
      const row = {
        product_name: "NewItem",
        quantity: 1,
        unit: "each",
        location_name: undefined,
      };

      const result = processRowInMemory(row, 0, lookups, { dryRun: false });

      expect(result.item.action).toBe("product_only");
      expect(result.item.productWillBeCreated).toBe(true);
      expect(result.productToCreate).toBeDefined();
    });
  });
});
