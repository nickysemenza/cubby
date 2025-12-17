import { beforeEach, describe, expect, it } from "vitest";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { type OrganizationId, unsafeUserId } from "~/schemas/identifiers";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  createInventoryEntry,
  importInventoryFromCSV,
} from "~/server/repo/inventory";
import { type InventoryCSVRow } from "~/schemas/inventory";

// Test user ID for audit logging
const TEST_USER_ID = unsafeUserId("test-user-id-for-csv-import");

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
        TEST_USER_ID,
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
        TEST_USER_ID,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "lbs" },
        },
        organizationId,
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
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
        TEST_USER_ID,
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
        TEST_USER_ID,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "kg" },
        },
        organizationId,
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
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
        { dryRun: true, userId: TEST_USER_ID },
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
        TEST_USER_ID,
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
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
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
        TEST_USER_ID,
      );

      // Create Location B which the CSV will reference
      const _locationB = await createLocation(
        db,
        { name: "Location B", type: "room", parentId: null },
        organizationId,
        TEST_USER_ID,
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
        TEST_USER_ID,
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
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
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
        TEST_USER_ID,
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
        TEST_USER_ID,
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
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
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
        TEST_USER_ID,
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
        TEST_USER_ID,
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
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
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
        TEST_USER_ID,
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
        TEST_USER_ID,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        organizationId,
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
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
        TEST_USER_ID,
      );

      const child = await createLocation(
        db,
        { name: "Fridge", type: "shelf", parentId: parent.id },
        organizationId,
        TEST_USER_ID,
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
        TEST_USER_ID,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: child.id,
          amount: { value: 1, unit: "gallon" },
        },
        organizationId,
        TEST_USER_ID,
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
        { dryRun: true, userId: TEST_USER_ID },
      );

      expect(result.skipped).toBe(1);
      expect(result.items[0].action).toBe("skipped");
    });
  });

  describe("type inference from context", () => {
    it("should infer type from later row with bracket notation", async () => {
      // Row 1: bare path (no types)
      // Row 2: same path with explicit types
      // Both should use the types from row 2
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Widget A",
          location_path: "garage > chrome wire shelf > bin",
          quantity: 1,
          unit: "each",
        },
        {
          product_name: "Widget B",
          location_path:
            "garage[room] > chrome wire shelf[shelf] > bin[half-crate]",
          quantity: 1,
          unit: "each",
        },
      ];

      const result = await importInventoryFromCSV(db, organizationId, rows, {
        dryRun: false,
        userId: TEST_USER_ID,
      });

      expect(result.created).toBe(2);
      expect(result.errors).toBe(0);

      // Verify location types were set correctly
      // The bin should be "half-crate" not the default "shelf"
      const { locationList } = await import("~/server/repo/location");

      const locations = await locationList(
        db,
        organizationId,
        undefined,
        undefined,
        { orderBy: "name", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );

      const bin = locations.data.find((l) => l.name === "bin");
      const shelf = locations.data.find((l) => l.name === "chrome wire shelf");
      const garage = locations.data.find((l) => l.name === "garage");

      expect(garage?.type).toBe("room");
      expect(shelf?.type).toBe("shelf");
      expect(bin?.type).toBe("half-crate");
    });

    it("should infer type from earlier row with bracket notation", async () => {
      // Row 1: explicit types
      // Row 2: bare path (should inherit types from row 1)
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Widget A",
          location_path: "warehouse[room] > rack1[shelf] > container[crate]",
          quantity: 1,
          unit: "each",
        },
        {
          product_name: "Widget B",
          location_path: "warehouse > rack1 > container",
          quantity: 1,
          unit: "each",
        },
      ];

      const result = await importInventoryFromCSV(db, organizationId, rows, {
        dryRun: false,
        userId: TEST_USER_ID,
      });

      expect(result.created).toBe(2);
      expect(result.errors).toBe(0);

      const { locationList } = await import("~/server/repo/location");
      const locations = await locationList(
        db,
        organizationId,
        undefined,
        undefined,
        { orderBy: "name", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );

      const container = locations.data.find((l) => l.name === "container");
      expect(container?.type).toBe("crate");
    });

    it("should use database type for existing locations", async () => {
      // Pre-create a location with a specific type
      await createLocation(
        db,
        { name: "Storage", type: "cabinet", parentId: null },
        organizationId,
        TEST_USER_ID,
      );

      // Import with bare path - should use existing "cabinet" type
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Widget",
          location_path: "Storage > new shelf",
          quantity: 1,
          unit: "each",
        },
      ];

      const result = await importInventoryFromCSV(db, organizationId, rows, {
        dryRun: false,
        userId: TEST_USER_ID,
      });

      expect(result.created).toBe(1);

      const { locationList } = await import("~/server/repo/location");
      const locations = await locationList(
        db,
        organizationId,
        undefined,
        undefined,
        { orderBy: "name", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );

      const storage = locations.data.find((l) => l.name === "Storage");
      const newShelf = locations.data.find((l) => l.name === "new shelf");

      // Storage should retain its original type
      expect(storage?.type).toBe("cabinet");
      // new shelf should default to "shelf" since it's a child
      expect(newShelf?.type).toBe("shelf");
    });

    it("should detect conflicting type specifications within CSV as error", async () => {
      // Two rows with same path but different types
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Widget A",
          location_path: "room1[room]",
          quantity: 1,
          unit: "each",
        },
        {
          product_name: "Widget B",
          location_path: "room1[cabinet]",
          quantity: 1,
          unit: "each",
        },
      ];

      const result = await importInventoryFromCSV(db, organizationId, rows, {
        dryRun: true,
        userId: TEST_USER_ID,
      });

      // Should return error for conflict
      expect(result.errors).toBeGreaterThan(0);
      expect(result.items.some((r) => r.action === "error")).toBe(true);
      expect(result.items.some((r) => r.message?.includes("conflict"))).toBe(
        true,
      );
    });

    it("should detect conflict when CSV type differs from existing database location", async () => {
      // Pre-create a location with type "room"
      await createLocation(
        db,
        { name: "ExistingRoom", type: "room", parentId: null },
        organizationId,
        TEST_USER_ID,
      );

      // CSV tries to specify a different type for the same location
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Widget",
          location_path: "ExistingRoom[cabinet]", // Different type than DB
          quantity: 1,
          unit: "each",
        },
      ];

      const result = await importInventoryFromCSV(db, organizationId, rows, {
        dryRun: true,
        userId: TEST_USER_ID,
      });

      // Should return error for conflict with database
      expect(result.errors).toBeGreaterThan(0);
      expect(result.items.some((r) => r.action === "error")).toBe(true);
      expect(result.items.some((r) => r.message?.includes("conflict"))).toBe(
        true,
      );
    });

    it("should handle partial type specifications", async () => {
      // Only some parts have explicit types
      const rows: InventoryCSVRow[] = [
        {
          product_name: "Widget",
          location_path: "office > drawer1[drawer] > section",
          quantity: 1,
          unit: "each",
        },
      ];

      const result = await importInventoryFromCSV(db, organizationId, rows, {
        dryRun: false,
        userId: TEST_USER_ID,
      });

      expect(result.created).toBe(1);

      const { locationList } = await import("~/server/repo/location");
      const locations = await locationList(
        db,
        organizationId,
        undefined,
        undefined,
        { orderBy: "name", direction: "asc" },
        { pageIndex: 0, pageSize: 100 },
      );

      const office = locations.data.find((l) => l.name === "office");
      const drawer1 = locations.data.find((l) => l.name === "drawer1");
      const section = locations.data.find((l) => l.name === "section");

      // office -> default "room" (root)
      expect(office?.type).toBe("room");
      // drawer1 -> explicit "drawer"
      expect(drawer1?.type).toBe("drawer");
      // section -> default "shelf" (child without explicit type)
      expect(section?.type).toBe("shelf");
    });
  });
});
