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
import { type InventoryCSVRow } from "~/schemas/inventory";
import { type InventoryCSVExportRow } from "~/server/repo/inventory/types";

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
});
