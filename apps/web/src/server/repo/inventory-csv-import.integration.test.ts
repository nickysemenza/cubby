import { beforeEach, describe, expect, it } from "vitest";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { type OrganizationId } from "~/schemas/identifiers";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  createInventoryEntry,
  importInventoryFromCSV,
} from "~/server/repo/inventory";
import { type InventoryCSVRow } from "~/schemas/inventory";

describe("CSV import preview logic", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());
    return teardown;
  });

  describe("skip detection", () => {
    it("should skip when re-importing existing data with matching quantity", async () => {
      // Create product, location, and inventory entry
      const location = await createLocation(
        db,
        { name: "Kitchen", type: "room", parentId: null },
        organizationId,
      );

      const product = await createProduct(
        db,
        {
          name: "Test Flour",
          manufacturer: "Brand A",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        organizationId,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "lbs" },
        },
        organizationId,
      );

      // Import same data with dryRun
      const csvRow: InventoryCSVRow = {
        product_name: "Test Flour",
        manufacturer: "Brand A",
        location_path: "Kitchen",
        quantity: 5,
        unit: "lbs",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true, // dryRun
      );

      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      expect(result.moved).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.items[0].action).toBe("skipped");
    });

    it("should show updated when quantity differs", async () => {
      const location = await createLocation(
        db,
        { name: "Pantry", type: "room", parentId: null },
        organizationId,
      );

      const product = await createProduct(
        db,
        {
          name: "Sugar",
          manufacturer: "Brand B",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        organizationId,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "kg" },
        },
        organizationId,
      );

      // Import with different quantity
      const csvRow: InventoryCSVRow = {
        product_name: "Sugar",
        manufacturer: "Brand B",
        location_path: "Pantry",
        quantity: 10,
        unit: "kg",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.items[0].action).toBe("updated");
    });
  });

  describe("create detection", () => {
    it("should show created for new product and location", async () => {
      const csvRow: InventoryCSVRow = {
        product_name: "New Product",
        manufacturer: "New Brand",
        location_path: "New Location",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      expect(result.created).toBe(1);
      expect(result.items[0].action).toBe("created");
      expect(result.items[0].productWillBeCreated).toBe(true);
      expect(result.items[0].locationWillBeCreated).toBe(true);
    });

    it("should show created for existing product at new location", async () => {
      const _existingLocation = await createLocation(
        db,
        { name: "Existing Room", type: "room", parentId: null },
        organizationId,
      );

      const _product = await createProduct(
        db,
        {
          name: "Existing Product",
          manufacturer: "Brand",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        organizationId,
      );

      // Product exists but not at "New Room"
      const csvRow: InventoryCSVRow = {
        product_name: "Existing Product",
        manufacturer: "Brand",
        location_path: "New Room",
        quantity: 2,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      expect(result.created).toBe(1);
      expect(result.items[0].action).toBe("created");
      expect(result.items[0].productWillBeCreated).toBe(false);
      expect(result.items[0].locationWillBeCreated).toBe(true);
    });
  });

  describe("move detection", () => {
    it("should show moved when unique item is at different location", async () => {
      const locationA = await createLocation(
        db,
        { name: "Location A", type: "room", parentId: null },
        organizationId,
      );

      // Create Location B which the CSV will reference
      const _locationB = await createLocation(
        db,
        { name: "Location B", type: "room", parentId: null },
        organizationId,
      );

      // Create a unique product (expectedQuantity=1)
      const product = await createProduct(
        db,
        {
          name: "Unique Tool",
          manufacturer: "ToolCo",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: 1,
          ingredientId: null,
          unitMappings: [],
        },
        organizationId,
      );

      // Currently at Location A
      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: locationA.id,
          amount: { value: 1, unit: "each" },
        },
        organizationId,
      );

      // Import to Location B
      const csvRow: InventoryCSVRow = {
        product_name: "Unique Tool",
        manufacturer: "ToolCo",
        location_path: "Location B",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      expect(result.moved).toBe(1);
      expect(result.items[0].action).toBe("moved");
      expect(result.items[0].movedFrom).toContain("Location A");
    });

    it("should NOT move when unique item is already at target location", async () => {
      const location = await createLocation(
        db,
        { name: "Garage", type: "room", parentId: null },
        organizationId,
      );

      // Create a unique product (expectedQuantity=1)
      const product = await createProduct(
        db,
        {
          name: "Power Drill",
          manufacturer: "DeWalt",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: 1,
          ingredientId: null,
          unitMappings: [],
        },
        organizationId,
      );

      // Already at Garage
      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        organizationId,
      );

      // Import to same location (Garage)
      const csvRow: InventoryCSVRow = {
        product_name: "Power Drill",
        manufacturer: "DeWalt",
        location_path: "Garage",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      // Should skip, NOT move
      expect(result.moved).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.items[0].action).toBe("skipped");
    });

    it("should show moved when moving unique item to new location that doesn't exist", async () => {
      // Create only Location A (target location doesn't exist yet)
      const locationA = await createLocation(
        db,
        { name: "Location A", type: "room", parentId: null },
        organizationId,
      );

      // Create a unique product (expectedQuantity=1)
      const product = await createProduct(
        db,
        {
          name: "Unique Item",
          manufacturer: "ItemCo",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: 1,
          ingredientId: null,
          unitMappings: [],
        },
        organizationId,
      );

      // Currently at Location A
      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: locationA.id,
          amount: { value: 1, unit: "each" },
        },
        organizationId,
      );

      // Import to "New Location" (doesn't exist yet)
      const csvRow: InventoryCSVRow = {
        product_name: "Unique Item",
        manufacturer: "ItemCo",
        location_path: "New Location",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      // Should be detected as a move (with new location being created)
      expect(result.moved).toBe(1);
      expect(result.items[0].action).toBe("moved");
      expect(result.items[0].locationWillBeCreated).toBe(true);
      expect(result.items[0].movedFrom).toContain("Location A");
    });
  });

  describe("product changes detection", () => {
    it("should detect price changes for existing product", async () => {
      const location = await createLocation(
        db,
        { name: "Store", type: "room", parentId: null },
        organizationId,
      );

      const product = await createProduct(
        db,
        {
          name: "Widget",
          manufacturer: "WidgetCo",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [], // No price mapping
        },
        organizationId,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        organizationId,
      );

      // Import with price
      const csvRow: InventoryCSVRow = {
        product_name: "Widget",
        manufacturer: "WidgetCo",
        location_path: "Store",
        quantity: 1,
        unit: "each",
        price: 9.99,
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      // Should skip (same quantity) but show price will be set
      expect(result.items[0].productChanges?.priceWillBeSet).toBe(9.99);
    });
  });

  describe("nested location paths", () => {
    it("should handle nested location paths for skip", async () => {
      const parent = await createLocation(
        db,
        { name: "Kitchen", type: "room", parentId: null },
        organizationId,
      );

      const child = await createLocation(
        db,
        { name: "Fridge", type: "shelf", parentId: parent.id },
        organizationId,
      );

      const product = await createProduct(
        db,
        {
          name: "Milk",
          manufacturer: "Farm Fresh",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        organizationId,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: child.id,
          amount: { value: 1, unit: "gallon" },
        },
        organizationId,
      );

      // Import with path format
      const csvRow: InventoryCSVRow = {
        product_name: "Milk",
        manufacturer: "Farm Fresh",
        location_path: "Kitchen > Fridge",
        quantity: 1,
        unit: "gallon",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        true,
      );

      expect(result.skipped).toBe(1);
      expect(result.items[0].action).toBe("skipped");
    });
  });
});
