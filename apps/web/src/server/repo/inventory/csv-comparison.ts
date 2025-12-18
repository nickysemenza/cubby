/**
 * CSV comparison utilities for import/export round-trip testing
 *
 * These functions are used by both the Google Sheets sync and tests
 * to compare inventory data between different representations.
 */

import {
  type InventoryCSVRow,
  type CSVImportResult,
  type CSVImportResultItem,
  type FieldChange,
} from "~/schemas/inventory";
import type { InventoryCSVExportRow } from "./types";
import { normalizeLocationPath } from "~/lib/location-path";
import {
  createResultCounters,
  buildImportResult,
  pushResultItem,
} from "./csv-result-helpers";

/**
 * Create a unique key for inventory comparison (product + manufacturer + location)
 *
 * Uses case-insensitive comparison for product name and manufacturer,
 * and normalized location path (strips brackets, lowercase).
 */
export function makeInventoryKey(
  productName: string,
  manufacturer: string,
  locationPath: string,
): string {
  return `${productName.toLowerCase()}|${manufacturer.toLowerCase()}|${normalizeLocationPath(locationPath)}`;
}

/**
 * Compare two row values and return structured field changes
 *
 * Compares an export row (from app) against an import row (from sheet/CSV)
 * and returns a list of fields that differ.
 */
export function getRowDifferences(
  appRow: InventoryCSVExportRow,
  sheetRow: InventoryCSVRow,
): FieldChange[] {
  const changes: FieldChange[] = [];

  // Compare location_path using normalized comparison (strips brackets, lowercase)
  // This ensures "Drawer[drawer]" matches "Drawer" as they refer to the same location
  const normalizedAppPath = normalizeLocationPath(appRow.location_path);
  const normalizedSheetPath = normalizeLocationPath(
    sheetRow.location_path ?? "",
  );
  if (normalizedAppPath !== normalizedSheetPath) {
    changes.push({
      field: "location",
      from: sheetRow.location_path ?? null,
      to: appRow.location_path,
    });
  }

  // For quantity/unit, treat null (product-only rows) as equivalent to defaults (1/each)
  // since the sheet schema applies these defaults when parsing empty cells
  const appQty = appRow.quantity ?? 1;
  const appUnit = appRow.unit ?? "each";
  if (appQty !== sheetRow.quantity) {
    changes.push({
      field: "qty",
      from: sheetRow.quantity,
      to: appRow.quantity,
    });
  }
  if (appUnit !== sheetRow.unit) {
    changes.push({ field: "unit", from: sheetRow.unit, to: appRow.unit });
  }
  if ((appRow.upc ?? "") !== (sheetRow.upc ?? "")) {
    changes.push({
      field: "upc",
      from: sheetRow.upc ?? null,
      to: appRow.upc ?? null,
    });
  }
  if ((appRow.model ?? "") !== (sheetRow.model ?? "")) {
    changes.push({
      field: "model",
      from: sheetRow.model ?? null,
      to: appRow.model ?? null,
    });
  }
  if ((appRow.ndb_number ?? null) !== (sheetRow.ndb_number ?? null)) {
    changes.push({
      field: "ndb",
      from: sheetRow.ndb_number ?? null,
      to: appRow.ndb_number ?? null,
    });
  }
  if ((appRow.expected_qty ?? null) !== (sheetRow.expected_qty ?? null)) {
    changes.push({
      field: "expected",
      from: sheetRow.expected_qty ?? null,
      to: appRow.expected_qty ?? null,
    });
  }
  if ((appRow.price ?? null) !== (sheetRow.price ?? null)) {
    changes.push({
      field: "price",
      from: sheetRow.price ?? null,
      to: appRow.price ?? null,
    });
  }
  if ((appRow.unit_mappings ?? "") !== (sheetRow.unit_mappings ?? "")) {
    changes.push({
      field: "unit_mappings",
      from: sheetRow.unit_mappings ?? null,
      to: appRow.unit_mappings ?? null,
    });
  }
  if ((appRow.ingredient_name ?? "") !== (sheetRow.ingredient_name ?? "")) {
    changes.push({
      field: "ingredient",
      from: sheetRow.ingredient_name ?? null,
      to: appRow.ingredient_name ?? null,
    });
  }
  if ((appRow.aliases ?? "") !== (sheetRow.aliases ?? "")) {
    changes.push({
      field: "aliases",
      from: sheetRow.aliases ?? null,
      to: appRow.aliases ?? null,
    });
  }

  return changes;
}

/**
 * Compare app inventory rows with sheet rows to generate a diff preview
 *
 * Used by push preview to show what changes would be made to the sheet,
 * and by round-trip tests to verify export/import symmetry.
 */
export function compareInventoryForPush(
  appRows: InventoryCSVExportRow[],
  sheetRows: InventoryCSVRow[],
): CSVImportResult {
  const items: CSVImportResultItem[] = [];
  const counters = createResultCounters();

  // Build a map of sheet rows by key
  const sheetMap = new Map<string, InventoryCSVRow>();
  for (const row of sheetRows) {
    const key = makeInventoryKey(
      row.product_name,
      row.manufacturer ?? "(unspecified)",
      row.location_path ?? "",
    );
    sheetMap.set(key, row);
  }

  // Track which sheet keys we've seen
  const seenSheetKeys = new Set<string>();

  // Compare app rows against sheet
  for (let i = 0; i < appRows.length; i++) {
    const appRow = appRows[i];
    const key = makeInventoryKey(
      appRow.product_name,
      appRow.manufacturer,
      appRow.location_path,
    );
    seenSheetKeys.add(key);

    const sheetRow = sheetMap.get(key);

    if (!sheetRow) {
      // New row - doesn't exist in sheet
      pushResultItem(items, counters, "created", {
        rowIndex: i,
        productName: appRow.product_name,
        locationPath: appRow.location_path,
        locationId: appRow.location_id ?? undefined,
        message: "Will be added to sheet",
      });
    } else {
      // Row exists - check if different
      const fieldChanges = getRowDifferences(appRow, sheetRow);

      if (fieldChanges.length > 0) {
        pushResultItem(items, counters, "updated", {
          rowIndex: i,
          productName: appRow.product_name,
          locationPath: appRow.location_path,
          locationId: appRow.location_id ?? undefined,
          fieldChanges,
        });
      } else {
        pushResultItem(items, counters, "skipped", {
          rowIndex: i,
          productName: appRow.product_name,
          locationPath: appRow.location_path,
          locationId: appRow.location_id ?? undefined,
        });
      }
    }
  }

  // Find rows in sheet that aren't in app (will be removed)
  for (const [key, sheetRow] of sheetMap) {
    if (!seenSheetKeys.has(key)) {
      pushResultItem(items, counters, "removed", {
        rowIndex: -1, // Not in app
        productName: sheetRow.product_name,
        locationPath: sheetRow.location_path ?? undefined,
        message: "Will be removed from sheet",
      });
    }
  }

  return buildImportResult(counters, items);
}

/**
 * Convert an export row to an import row format
 *
 * Handles the differences between InventoryCSVExportRow and InventoryCSVRow:
 * - Strips location_id (export-only field)
 * - Converts empty strings to undefined
 * - Handles null -> default value conversions
 */
export function exportRowToImportRow(
  row: InventoryCSVExportRow,
): InventoryCSVRow {
  return {
    product_name: row.product_name,
    manufacturer: row.manufacturer,
    upc: row.upc || undefined,
    model: row.model ?? undefined,
    ndb_number: row.ndb_number ?? undefined,
    location_path: row.location_path || undefined,
    quantity: row.quantity ?? 1,
    unit: row.unit ?? "each",
    expected_qty: row.expected_qty ?? undefined,
    price: row.price ?? undefined,
    unit_mappings: row.unit_mappings ?? undefined,
    ingredient_name: row.ingredient_name ?? undefined,
    aliases: row.aliases ?? undefined,
  };
}
