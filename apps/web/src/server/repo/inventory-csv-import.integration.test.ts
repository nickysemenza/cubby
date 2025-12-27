import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "~/schemas/context";
import type { OrganizationId } from "~/schemas/identifiers";
import type { InventoryCSVRow } from "~/schemas/inventory";
import type { Database } from "~/server/db";
import {
  createInventoryEntry,
  importInventoryFromCSV,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";

describe("CSV import preview logic", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let actor: ActorContext;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, organizationId, actor, teardown } = await buildTestDB());
    return teardown;
  });

  describe("skip detection", () => {
    it("should skip when re-importing existing data with matching quantity", async () => {
      // Create product, location, and inventory entry
      const location = await createLocation(
        db,
        { name: "Kitchen", type: "room", parentId: null },
        actor,
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
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "lbs" },
        },
        actor,
      );

      // Import same data with dryRun
      const csvRow: InventoryCSVRow = {
        product_name: "Test Flour",
        manufacturer: "Brand A",
        location_name: "Kitchen",
        quantity: 5,
        unit: "lbs",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
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
        actor,
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
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "kg" },
        },
        actor,
      );

      // Import with different quantity
      const csvRow: InventoryCSVRow = {
        product_name: "Sugar",
        manufacturer: "Brand B",
        location_name: "Pantry",
        quantity: 10,
        unit: "kg",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
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
        location_name: "New Location",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      expect(result.created).toBe(1);
      expect(result.items[0].action).toBe("created");
      expect(result.items[0].productWillBeCreated).toBe(true);
      expect(result.items[0].locationNotFound).toBe(true);
    });

    it("should show created for existing product at new location", async () => {
      await createLocation(
        db,
        { name: "Existing Room", type: "room", parentId: null },
        actor,
      );

      // Create the target location as well
      await createLocation(
        db,
        { name: "New Room", type: "room", parentId: null },
        actor,
      );

      await createProduct(
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
        actor,
      );

      // Product exists but not at "New Room"
      const csvRow: InventoryCSVRow = {
        product_name: "Existing Product",
        manufacturer: "Brand",
        location_name: "New Room",
        quantity: 2,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      expect(result.created).toBe(1);
      expect(result.items[0].action).toBe("created");
      expect(result.items[0].productWillBeCreated).toBe(false);
    });
  });

  describe("move detection", () => {
    it("should show moved when unique item is at different location", async () => {
      const locationA = await createLocation(
        db,
        { name: "Location A", type: "room", parentId: null },
        actor,
      );

      // Create Location B which the CSV will reference
      await createLocation(
        db,
        { name: "Location B", type: "room", parentId: null },
        actor,
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
        actor,
      );

      // Currently at Location A
      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: locationA.id,
          amount: { value: 1, unit: "each" },
        },
        actor,
      );

      // Import to Location B
      const csvRow: InventoryCSVRow = {
        product_name: "Unique Tool",
        manufacturer: "ToolCo",
        location_name: "Location B",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      expect(result.moved).toBe(1);
      expect(result.items[0].action).toBe("moved");
      expect(result.items[0].movedFrom).toContain("Location A");
    });

    it("should NOT move when unique item is already at target location", async () => {
      const location = await createLocation(
        db,
        { name: "Garage", type: "room", parentId: null },
        actor,
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
        actor,
      );

      // Already at Garage
      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        actor,
      );

      // Import to same location (Garage)
      const csvRow: InventoryCSVRow = {
        product_name: "Power Drill",
        manufacturer: "DeWalt",
        location_name: "Garage",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      // Should skip, NOT move
      expect(result.moved).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.items[0].action).toBe("skipped");
    });

    it("should auto-create location when target location doesn't exist", async () => {
      // Create only Location A (target location doesn't exist yet)
      await createLocation(
        db,
        { name: "Location A", type: "room", parentId: null },
        actor,
      );

      // Create a unique product (expectedQuantity=1)
      await createProduct(
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
        actor,
      );

      // Import to "New Location" which doesn't exist - should be auto-created
      const csvRow: InventoryCSVRow = {
        product_name: "Unique Item",
        manufacturer: "ItemCo",
        location_name: "New Location",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      // In dry-run mode, should indicate location will be auto-created
      expect(result.created).toBe(1);
      expect(result.items[0].action).toBe("created");
      expect(result.items[0].locationNotFound).toBe(true);
      expect(result.items[0].message).toContain("auto-created");
    });
  });

  describe("product changes detection", () => {
    it("should detect price changes for existing product", async () => {
      const location = await createLocation(
        db,
        { name: "Store", type: "room", parentId: null },
        actor,
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
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        actor,
      );

      // Import with price
      const csvRow: InventoryCSVRow = {
        product_name: "Widget",
        manufacturer: "WidgetCo",
        location_name: "Store",
        quantity: 1,
        unit: "each",
        price: 9.99,
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
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
        actor,
      );

      const child = await createLocation(
        db,
        { name: "Fridge", type: "shelf", parentId: parent.id },
        actor,
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
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: child.id,
          amount: { value: 1, unit: "gallon" },
        },
        actor,
      );

      // Import with just the location name (locations must exist)
      const csvRow: InventoryCSVRow = {
        product_name: "Milk",
        manufacturer: "Farm Fresh",
        location_name: "Fridge",
        quantity: 1,
        unit: "gallon",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      expect(result.skipped).toBe(1);
      expect(result.items[0].action).toBe("skipped");
    });
  });

  describe("fuzzy manufacturer matching", () => {
    it("should match existing product with specific manufacturer when importing with (unspecified)", async () => {
      // Create product with specific manufacturer
      const location = await createLocation(
        db,
        { name: "Garage", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Power Drill",
          manufacturer: "DeWalt",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        actor,
      );

      // Import with (unspecified) manufacturer - should match existing product
      const csvRow: InventoryCSVRow = {
        product_name: "Power Drill",
        manufacturer: "(unspecified)",
        location_name: "Garage",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      // Should skip because it matches existing product
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      expect(result.items[0].productWillBeCreated).toBe(false);
    });

    it("should update manufacturer from (unspecified) to specific when importing", async () => {
      // Create product with (unspecified) manufacturer
      const location = await createLocation(
        db,
        { name: "Workshop", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Router Table",
          manufacturer: "(unspecified)",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        actor,
      );

      // Import with specific manufacturer - should update product
      const csvRow: InventoryCSVRow = {
        product_name: "Router Table",
        manufacturer: "Bosch",
        location_name: "Workshop",
        quantity: 1,
        unit: "each",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      // Should show manufacturer update in changes
      expect(result.items[0].productChanges?.manufacturerWillBeSet).toBe(
        "Bosch",
      );
      expect(result.items[0].productChanges?.manufacturerCurrent).toBe(
        "(unspecified)",
      );
    });

    it("should actually update manufacturer when not in dryRun mode", async () => {
      // Create product with (unspecified) manufacturer
      const location = await createLocation(
        db,
        { name: "Shed", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Lawn Mower",
          manufacturer: "(unspecified)",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        actor,
      );

      // Import with specific manufacturer (not dryRun)
      const csvRow: InventoryCSVRow = {
        product_name: "Lawn Mower",
        manufacturer: "Honda",
        location_name: "Shed",
        quantity: 1,
        unit: "each",
      };

      await importInventoryFromCSV(db, organizationId, [csvRow], {
        dryRun: false,
        actor: actor,
      });

      // Verify manufacturer was updated
      const { getProductByID } = await import("~/server/repo/product");
      const updatedProduct = await getProductByID(
        db,
        product.id,
        organizationId,
      );
      expect(updatedProduct.manufacturer).toBe("Honda");
    });
  });

  describe("unit mappings round-trip", () => {
    it("should not show false positive unit_mappings changes on re-import", async () => {
      // Create product with unit mappings
      const location = await createLocation(
        db,
        { name: "Kitchen", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Flour",
          manufacturer: "King Arthur",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: "test",
            },
          ],
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "lbs" },
        },
        actor,
      );

      // Re-import with same unit mappings
      const csvRow: InventoryCSVRow = {
        product_name: "Flour",
        manufacturer: "King Arthur",
        location_name: "Kitchen",
        quantity: 5,
        unit: "lbs",
        unit_mappings: "1 cup = 120g",
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      // Should skip - no changes detected including unit mappings
      expect(result.skipped).toBe(1);
      expect(result.items[0].productChanges?.unitMappingsWillBeAdded).toBe(
        undefined,
      );
    });

    it("should detect actual unit_mappings changes", async () => {
      // Create product with unit mappings
      const location = await createLocation(
        db,
        { name: "Pantry", type: "cabinet", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Sugar",
          manufacturer: "Domino",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 200, unit: "g" },
              source: "test",
            },
          ],
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 2, unit: "lbs" },
        },
        actor,
      );

      // Import with DIFFERENT unit mappings
      const csvRow: InventoryCSVRow = {
        product_name: "Sugar",
        manufacturer: "Domino",
        location_name: "Pantry",
        quantity: 2,
        unit: "lbs",
        unit_mappings: "1 tbsp = 12g", // Different from existing
      };

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        [csvRow],
        { dryRun: true, actor: actor },
      );

      // Should show unit mapping changes
      expect(result.items[0].productChanges?.unitMappingsWillBeAdded).toBe(1);
    });
  });
});
