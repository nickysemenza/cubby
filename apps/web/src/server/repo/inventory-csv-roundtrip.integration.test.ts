/**
 * CSV/Sheets Round-Trip Tests
 *
 * Verifies symmetry between CSV import and export flows:
 * - Export → Import should result in all "skipped" (no changes detected)
 * - Import → Export → Import should result in all "skipped"
 * - Self-comparison using compareInventoryForPush should show all "skipped"
 */

import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "~/schemas/context";
import type { OrganizationId, ProductId } from "~/schemas/identifiers";
import type { InventoryCSVRow } from "~/schemas/inventory";
import type { Database } from "~/server/db";
import { withTransaction } from "~/server/repo/database-helpers";
import {
  createInventoryEntry,
  importInventoryFromCSV,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { exportInventoryToCSV } from "~/server/repo/inventory/csv-export";
import { createOrUpdatePriceMapping } from "~/server/repo/inventory/csv-import";
import type { InventoryCSVExportRow } from "~/server/repo/inventory/types";
import { createLocation } from "~/server/repo/location";
import { createProduct, syncProductPrice } from "~/server/repo/product";
import { compareInventoryForSync } from "~/server/repo/sync";

/**
 * Convert an export row to an import row format (test helper)
 */
const exportRowToImportRow = (row: InventoryCSVExportRow): InventoryCSVRow => ({
  product_name: row.product_name,
  manufacturer: row.manufacturer,
  upc: row.upc || undefined,
  model: row.model ?? undefined,
  ndb_number: row.ndb_number ?? undefined,
  location_name: row.location_name || undefined,
  quantity: row.quantity ?? 1,
  unit: row.unit ?? "each",
  expected_qty: row.expected_qty ?? undefined,
  price: row.price ?? undefined,
  unit_mappings: row.unit_mappings ?? undefined,
  ingredient_name: row.ingredient_name ?? undefined,
  aliases: row.aliases ?? undefined,
});

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

  describe("Sync conflict resolution", () => {
    /**
     * Helper to simulate "use_sheet" resolution for a conflict.
     * This mirrors what processImportsToApp does when resolution="use_sheet"
     */
    const applyUseSheetResolution = async (
      db: Database,
      productId: ProductId,
      inventoryEntryId: string,
      sheetData: {
        quantity?: number;
        unit?: string;
        price?: number;
      },
      actor: ActorContext,
    ) => {
      // Update inventory entry quantity if provided
      if (sheetData.quantity !== undefined) {
        await updateInventoryEntry(
          db,
          inventoryEntryId as Parameters<typeof updateInventoryEntry>[1],
          {
            amount: {
              value: sheetData.quantity,
              unit: sheetData.unit ?? "each",
            },
          },
          actor,
        );
      }

      // Update price via unit mapping + sync if provided
      if (sheetData.price !== undefined) {
        await withTransaction(db, async (tx) => {
          await createOrUpdatePriceMapping(
            tx,
            productId,
            { value: sheetData.price!, unit: "dollar" },
            "test",
          );
          await syncProductPrice(tx, productId);
        });
      }
    };

    it("should resolve quantity conflict when use_sheet is applied", async () => {
      // Setup: Create product and inventory with quantity=5
      const location = await createLocation(
        db,
        { name: "Storage", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Test Product",
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

      const entry = await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 5, unit: "each" },
        },
        actor,
      );

      // Simulate sheet data with different quantity (quantity=10)
      const sheetRow: InventoryCSVRow = {
        product_name: "Test Product",
        manufacturer: "Brand",
        location_name: "Storage",
        quantity: 10,
        unit: "each",
      };

      // Detect conflict
      const appRows = await exportInventoryToCSV(db, organizationId);
      const syncResult = compareInventoryForSync(appRows, [sheetRow]);

      expect(syncResult).toHaveLength(1);
      expect(syncResult[0].state).toBe("conflict");
      expect(syncResult[0].fieldDiffs).toBeDefined();
      expect(syncResult[0].fieldDiffs?.some((d) => d.field === "qty")).toBe(
        true,
      );

      // Apply "use_sheet" resolution
      await applyUseSheetResolution(
        db,
        product.id,
        entry.id,
        { quantity: 10, unit: "each" },
        actor,
      );

      // Verify: re-run comparison, should now match
      const appRowsAfter = await exportInventoryToCSV(db, organizationId);
      const syncResultAfter = compareInventoryForSync(appRowsAfter, [sheetRow]);

      expect(syncResultAfter).toHaveLength(1);
      expect(syncResultAfter[0].state).toBe("matched");
    });

    it("should resolve price conflict when use_sheet is applied", async () => {
      // Setup: Create product without price
      const location = await createLocation(
        db,
        { name: "Warehouse", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Priced Item",
          manufacturer: "PriceCo",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [], // No price initially
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

      // Simulate sheet data with price
      const sheetRow: InventoryCSVRow = {
        product_name: "Priced Item",
        manufacturer: "PriceCo",
        location_name: "Warehouse",
        quantity: 1,
        unit: "each",
        price: 25.99,
      };

      // Detect conflict (price difference)
      const appRows = await exportInventoryToCSV(db, organizationId);
      const syncResult = compareInventoryForSync(appRows, [sheetRow]);

      expect(syncResult).toHaveLength(1);
      expect(syncResult[0].state).toBe("conflict");
      expect(syncResult[0].fieldDiffs?.some((d) => d.field === "price")).toBe(
        true,
      );

      // Apply "use_sheet" resolution for price
      await applyUseSheetResolution(
        db,
        product.id,
        "", // No inventory entry update needed
        { price: 25.99 },
        actor,
      );

      // Verify: re-run comparison, should now match
      const appRowsAfter = await exportInventoryToCSV(db, organizationId);
      const syncResultAfter = compareInventoryForSync(appRowsAfter, [sheetRow]);

      expect(syncResultAfter).toHaveLength(1);
      expect(syncResultAfter[0].state).toBe("matched");
    });

    it("should resolve both quantity and price conflicts when use_sheet is applied", async () => {
      // Setup: Create product with initial price and quantity
      const location = await createLocation(
        db,
        { name: "Shop", type: "room", parentId: null },
        actor,
      );

      const product = await createProduct(
        db,
        {
          name: "Combo Item",
          manufacturer: "ComboCo",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [
            {
              a: { value: 1, unit: "each" },
              b: { value: 10.0, unit: "dollar" },
              source: "test",
            },
          ],
        },
        actor,
      );

      const entry = await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: 3, unit: "each" },
        },
        actor,
      );

      // Simulate sheet data with different quantity AND price
      const sheetRow: InventoryCSVRow = {
        product_name: "Combo Item",
        manufacturer: "ComboCo",
        location_name: "Shop",
        quantity: 7, // App has 3
        unit: "each",
        price: 15.0, // App has 10
      };

      // Detect conflict
      const appRows = await exportInventoryToCSV(db, organizationId);
      const syncResult = compareInventoryForSync(appRows, [sheetRow]);

      expect(syncResult).toHaveLength(1);
      expect(syncResult[0].state).toBe("conflict");
      expect(syncResult[0].fieldDiffs?.length).toBeGreaterThanOrEqual(2);

      // Apply "use_sheet" resolution for both
      await applyUseSheetResolution(
        db,
        product.id,
        entry.id,
        { quantity: 7, unit: "each", price: 15.0 },
        actor,
      );

      // Verify: re-run comparison, should now match
      const appRowsAfter = await exportInventoryToCSV(db, organizationId);
      const syncResultAfter = compareInventoryForSync(appRowsAfter, [sheetRow]);

      expect(syncResultAfter).toHaveLength(1);
      expect(syncResultAfter[0].state).toBe("matched");

      // Verify the actual values were updated
      const exportedAfter = appRowsAfter[0];
      expect(exportedAfter.quantity).toBe(7);
      expect(exportedAfter.price).toBe(15.0);
    });
  });
});
