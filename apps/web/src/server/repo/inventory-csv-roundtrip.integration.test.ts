/**
 * CSV/Sheets Round-Trip Tests
 *
 * Verifies symmetry between CSV import and export flows:
 * - Export → Import should result in all "skipped" (no changes detected)
 * - Import → Export → Import should result in all "skipped"
 * - Self-comparison using compareInventoryForPush should show all "skipped"
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { type OrganizationId } from "~/schemas/identifiers";
import { type ActorContext } from "~/schemas/context";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  createInventoryEntry,
  importInventoryFromCSV,
} from "~/server/repo/inventory";
import { exportInventoryToCSV } from "~/server/repo/inventory/csv-export";
import {
  compareInventoryForPush,
  exportRowToImportRow,
} from "~/server/repo/inventory/csv-comparison";
import { type InventoryCSVRow } from "~/schemas/inventory";

describe("CSV round-trip tests", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let actor: ActorContext;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, organizationId, actor, teardown } = await buildTestDB());
    return teardown;
  });

  describe("Export → Import round-trip", () => {
    it("should skip all rows when re-importing exported data", async () => {
      // Setup: Create product, location, and inventory entry
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
          upc: "123456789012",
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

      // Export to CSV rows
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      expect(exportedRows.length).toBe(1);

      // Convert export rows to import format
      const importRows = exportedRows.map(exportRowToImportRow);

      // Re-import with dryRun
      const result = await importInventoryFromCSV(
        db,
        organizationId,
        importRows,
        {
          dryRun: true,
          actor: actor,
        },
      );

      // All should be skipped
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.moved).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.items[0].action).toBe("skipped");
    });

    it("should skip all rows with nested location paths", async () => {
      // Setup: Create nested locations
      const parent = await createLocation(
        db,
        { name: "Kitchen", type: "room", parentId: null },
        actor,
      );

      const child = await createLocation(
        db,
        { name: "Pantry", type: "cabinet", parentId: parent.id },
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
          unitMappings: [],
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: child.id,
          amount: { value: 2, unit: "kg" },
        },
        actor,
      );

      // Export and re-import
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      const importRows = exportedRows.map(exportRowToImportRow);

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        importRows,
        {
          dryRun: true,
          actor: actor,
        },
      );

      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("should skip all rows with product-only entries (no location)", async () => {
      // Setup: Create product without inventory
      await createProduct(
        db,
        {
          name: "Unused Product",
          manufacturer: "Brand X",
          model: "ModelY",
          upc: null,
          ndb_number: null,
          expectedQuantity: 5,
          ingredientId: null,
          unitMappings: [],
        },
        actor,
      );

      // Export (includes product-only rows)
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      expect(exportedRows.length).toBe(1);
      expect(exportedRows[0].location_name).toBe("");

      // Convert and re-import
      const importRows = exportedRows.map(exportRowToImportRow);

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        importRows,
        {
          dryRun: true,
          actor: actor,
        },
      );

      // Product-only row with no changes should be skipped
      expect(result.skipped).toBe(1);
      expect(result.productOnly).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  describe("Import → Export → Import round-trip", () => {
    it("should produce identical data after full cycle", async () => {
      // Create locations first
      const warehouse = await createLocation(
        db,
        { name: "Warehouse", type: "room", parentId: null },
        actor,
      );
      await createLocation(
        db,
        { name: "Shelf A", type: "shelf", parentId: warehouse.id },
        actor,
      );

      // Step 1: Import CSV rows
      const csvRows: InventoryCSVRow[] = [
        {
          product_name: "Widget A",
          manufacturer: "WidgetCo",
          upc: "111222333444",
          model: "WA-100",
          location_name: "Warehouse",
          quantity: 10,
          unit: "each",
          expected_qty: 20,
        },
        {
          product_name: "Widget B",
          manufacturer: "WidgetCo",
          location_name: "Shelf A",
          quantity: 5,
          unit: "boxes",
        },
      ];

      const importResult = await importInventoryFromCSV(
        db,
        organizationId,
        csvRows,
        { dryRun: false, actor: actor },
      );

      expect(importResult.created).toBe(2);
      expect(importResult.errors).toBe(0);

      // Step 2: Export the data
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      expect(exportedRows.length).toBe(2);

      // Step 3: Re-import the export
      const reimportRows = exportedRows.map(exportRowToImportRow);
      const reimportResult = await importInventoryFromCSV(
        db,
        organizationId,
        reimportRows,
        { dryRun: true, actor: actor },
      );

      // All should be skipped
      expect(reimportResult.skipped).toBe(2);
      expect(reimportResult.created).toBe(0);
      expect(reimportResult.updated).toBe(0);
      expect(reimportResult.errors).toBe(0);
    });

    it("should preserve all fields through round-trip", async () => {
      // Create location first
      await createLocation(
        db,
        { name: "Storage", type: "room", parentId: null },
        actor,
      );

      // Import with various optional fields
      const csvRows: InventoryCSVRow[] = [
        {
          product_name: "Test Product",
          manufacturer: "Test Brand",
          upc: "999888777666",
          model: "TP-500",
          ndb_number: 12345,
          location_name: "Storage",
          quantity: 7,
          unit: "pieces",
          expected_qty: 10,
          price: 29.99,
        },
      ];

      await importInventoryFromCSV(db, organizationId, csvRows, {
        dryRun: false,
        actor: actor,
      });

      // Export and verify fields preserved
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      expect(exportedRows.length).toBe(1);

      const exported = exportedRows[0];
      expect(exported.product_name).toBe("Test Product");
      expect(exported.manufacturer).toBe("Test Brand");
      expect(exported.upc).toBe("999888777666");
      expect(exported.model).toBe("TP-500");
      expect(exported.ndb_number).toBe(12345);
      expect(exported.quantity).toBe(7);
      expect(exported.unit).toBe("pieces");
      expect(exported.expected_qty).toBe(10);
      expect(exported.price).toBe(29.99);
    });
  });

  describe("Push preview self-comparison", () => {
    it("should show all skipped when comparing export against itself", async () => {
      // Setup data
      const location = await createLocation(
        db,
        { name: "Office", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Stapler",
          manufacturer: "Swingline",
          model: "747",
          upc: null,
          ndb_number: null,
          expectedQuantity: 1,
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

      // Export current state
      const exportedRows = await exportInventoryToCSV(db, organizationId);

      // Convert export rows to sheet format (InventoryCSVRow)
      const sheetRows = exportedRows.map(exportRowToImportRow);

      // Compare against itself
      const result = compareInventoryForPush(exportedRows, sheetRows);

      // All should be skipped
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBeUndefined();
      expect(result.errors).toBe(0);
    });

    it("should detect additions when app has more rows than sheet", async () => {
      // Setup: Create 2 products, but "sheet" only has 1
      const location = await createLocation(
        db,
        { name: "Desk", type: "room", parentId: null },
        actor,
      );

      const product1 = await createProduct(
        db,
        {
          name: "Pen",
          manufacturer: "Pilot",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        actor,
      );

      const product2 = await createProduct(
        db,
        {
          name: "Pencil",
          manufacturer: "Dixon",
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
          productId: product1.id,
          locationId: location.id,
          amount: { value: 5, unit: "each" },
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product2.id,
          locationId: location.id,
          amount: { value: 10, unit: "each" },
        },
        actor,
      );

      // Export full app data
      const appRows = await exportInventoryToCSV(db, organizationId);
      expect(appRows.length).toBe(2);

      // Simulate sheet with only one row
      const sheetRows: InventoryCSVRow[] = [
        {
          product_name: "Pen",
          manufacturer: "Pilot",
          location_name: "Desk",
          quantity: 5,
          unit: "each",
        },
      ];

      const result = compareInventoryForPush(appRows, sheetRows);

      expect(result.skipped).toBe(1); // Pen matches
      expect(result.created).toBe(1); // Pencil is new
      expect(result.removed).toBeUndefined(); // Nothing to remove
    });

    it("should detect removals when sheet has more rows than app", async () => {
      // Setup: Create 1 product in app
      const location = await createLocation(
        db,
        { name: "Drawer", type: "drawer", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Scissors",
          manufacturer: "Fiskars",
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

      // Export app data
      const appRows = await exportInventoryToCSV(db, organizationId);

      // Simulate sheet with extra row
      const sheetRows: InventoryCSVRow[] = [
        {
          product_name: "Scissors",
          manufacturer: "Fiskars",
          location_name: "Drawer",
          quantity: 1,
          unit: "each",
        },
        {
          product_name: "Tape",
          manufacturer: "3M",
          location_name: "Drawer",
          quantity: 2,
          unit: "each",
        },
      ];

      const result = compareInventoryForPush(appRows, sheetRows);

      expect(result.skipped).toBe(1); // Scissors matches
      expect(result.removed).toBe(1); // Tape will be removed
    });

    it("should detect updates when field values differ", async () => {
      const location = await createLocation(
        db,
        { name: "Cabinet", type: "cabinet", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Notebook",
          manufacturer: "Moleskine",
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
          amount: { value: 3, unit: "each" },
        },
        actor,
      );

      // Export app data
      const appRows = await exportInventoryToCSV(db, organizationId);

      // Simulate sheet with different quantity
      const sheetRows: InventoryCSVRow[] = [
        {
          product_name: "Notebook",
          manufacturer: "Moleskine",
          location_name: "Cabinet",
          quantity: 5, // Different from app's 3
          unit: "each",
        },
      ];

      const result = compareInventoryForPush(appRows, sheetRows);

      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);

      const updatedItem = result.items.find((i) => i.action === "updated");
      expect(updatedItem?.fieldChanges).toBeDefined();
      expect(updatedItem?.fieldChanges?.some((c) => c.field === "qty")).toBe(
        true,
      );
    });
  });

  describe("Edge cases", () => {
    it("should handle manufacturer default '(unspecified)'", async () => {
      const location = await createLocation(
        db,
        { name: "Shelf", type: "shelf", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Generic Item",
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

      // Export and re-import
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      const importRows = exportedRows.map(exportRowToImportRow);

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        importRows,
        {
          dryRun: true,
          actor: actor,
        },
      );

      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("should handle mixed case product names (case-insensitive matching)", async () => {
      const location = await createLocation(
        db,
        { name: "Room", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Test Product",
          manufacturer: "Test Brand",
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

      // Export app data
      const appRows = await exportInventoryToCSV(db, organizationId);

      // Sheet with different case
      const sheetRows: InventoryCSVRow[] = [
        {
          product_name: "TEST PRODUCT",
          manufacturer: "TEST BRAND",
          location_name: "ROOM",
          quantity: 1,
          unit: "each",
        },
      ];

      // Compare should find a match (case-insensitive key)
      const result = compareInventoryForPush(appRows, sheetRows);

      // Should be skipped (matched), not created (different case but same item)
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
    });

    it("should handle multiple products at same location", async () => {
      const location = await createLocation(
        db,
        { name: "Pantry", type: "cabinet", parentId: null },
        actor,
      );

      const product1 = await createProduct(
        db,
        {
          name: "Rice",
          manufacturer: "Uncle Ben's",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
        },
        actor,
      );

      const product2 = await createProduct(
        db,
        {
          name: "Pasta",
          manufacturer: "Barilla",
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
          productId: product1.id,
          locationId: location.id,
          amount: { value: 2, unit: "lbs" },
        },
        actor,
      );

      await createInventoryEntry(
        db,
        {
          productId: product2.id,
          locationId: location.id,
          amount: { value: 3, unit: "boxes" },
        },
        actor,
      );

      // Export and re-import
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      expect(exportedRows.length).toBe(2);

      const importRows = exportedRows.map(exportRowToImportRow);
      const result = await importInventoryFromCSV(
        db,
        organizationId,
        importRows,
        {
          dryRun: true,
          actor: actor,
        },
      );

      expect(result.skipped).toBe(2);
      expect(result.errors).toBe(0);
    });

    it("should handle empty/null values correctly", async () => {
      const location = await createLocation(
        db,
        { name: "Storage", type: "room", parentId: null },
        actor,
      );

      // Create product with minimal fields (many nulls)
      const product = await createProduct(
        db,
        {
          name: "Basic Item",
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

      // Export and re-import
      const exportedRows = await exportInventoryToCSV(db, organizationId);
      const importRows = exportedRows.map(exportRowToImportRow);

      const result = await importInventoryFromCSV(
        db,
        organizationId,
        importRows,
        {
          dryRun: true,
          actor: actor,
        },
      );

      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });
  });
});
