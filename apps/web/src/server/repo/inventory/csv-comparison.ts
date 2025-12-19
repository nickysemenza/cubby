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
import { type InventoryId, type ProductId } from "~/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";

/**
 * Normalize manufacturer value (empty/null becomes UNSPECIFIED_MANUFACTURER)
 */
function normalizeManufacturer(
  manufacturer: string | null | undefined,
): string {
  return manufacturer?.trim() || UNSPECIFIED_MANUFACTURER;
}

/**
 * Check if two manufacturers are compatible for matching purposes.
 * "(unspecified)" acts as a wildcard and matches any manufacturer.
 */
function manufacturersMatch(
  mfr1: string | null | undefined,
  mfr2: string | null | undefined,
): boolean {
  const norm1 = normalizeManufacturer(mfr1).toLowerCase();
  const norm2 = normalizeManufacturer(mfr2).toLowerCase();

  // Exact match
  if (norm1 === norm2) return true;

  // "(unspecified)" matches anything
  const unspecified = UNSPECIFIED_MANUFACTURER.toLowerCase();
  if (norm1 === unspecified || norm2 === unspecified) return true;

  return false;
}

/**
 * Create a unique key for inventory comparison (product + manufacturer + location)
 *
 * Uses case-insensitive comparison for product name and manufacturer,
 * and normalized location path (strips brackets, lowercase).
 */
export function makeInventoryKey(
  productName: string,
  manufacturer: string | null | undefined,
  locationPath: string,
): string {
  return `${productName.toLowerCase()}|${normalizeManufacturer(manufacturer).toLowerCase()}|${normalizeLocationPath(locationPath)}`;
}

/**
 * Create a key for product + location lookup (ignoring manufacturer)
 * Used for fuzzy matching when manufacturer differs
 */
function makeProductLocationKey(
  productName: string,
  locationPath: string,
): string {
  return `${productName.toLowerCase()}|${normalizeLocationPath(locationPath)}`;
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
 *
 * Uses fuzzy manufacturer matching: "(unspecified)" matches any manufacturer.
 */
export function compareInventoryForPush(
  appRows: InventoryCSVExportRow[],
  sheetRows: InventoryCSVRow[],
): CSVImportResult {
  const items: CSVImportResultItem[] = [];
  const counters = createResultCounters();

  // Build a map of sheet rows by product+location key (ignoring manufacturer for lookup)
  // Each key may have multiple rows with different manufacturers
  const sheetByProductLocation = new Map<string, InventoryCSVRow[]>();
  for (const row of sheetRows) {
    const plKey = makeProductLocationKey(
      row.product_name,
      row.location_path ?? "",
    );
    const existing = sheetByProductLocation.get(plKey) ?? [];
    existing.push(row);
    sheetByProductLocation.set(plKey, existing);
  }

  // Track which sheet rows we've matched (by index in original array)
  const matchedSheetIndices = new Set<number>();

  // Compare app rows against sheet
  for (let i = 0; i < appRows.length; i++) {
    const appRow = appRows[i];
    const plKey = makeProductLocationKey(
      appRow.product_name,
      appRow.location_path,
    );

    // Find sheet rows with same product+location
    const candidates = sheetByProductLocation.get(plKey) ?? [];

    // Find a matching row (manufacturer must be compatible)
    let matchedSheetRow: InventoryCSVRow | undefined;
    let matchedSheetIndex = -1;

    for (let j = 0; j < candidates.length; j++) {
      const candidate = candidates[j];
      const sheetIndex = sheetRows.indexOf(candidate);

      // Skip already matched rows
      if (matchedSheetIndices.has(sheetIndex)) continue;

      // Check if manufacturers are compatible
      if (manufacturersMatch(appRow.manufacturer, candidate.manufacturer)) {
        matchedSheetRow = candidate;
        matchedSheetIndex = sheetIndex;
        break;
      }
    }

    if (!matchedSheetRow) {
      // New row - doesn't exist in sheet
      pushResultItem(items, counters, "created", {
        rowIndex: i,
        productName: appRow.product_name,
        productId: appRow.product_id,
        locationPath: appRow.location_path,
        locationId: appRow.location_id ?? undefined,
        message: "Will be added to sheet",
      });
    } else {
      // Mark this sheet row as matched
      matchedSheetIndices.add(matchedSheetIndex);

      // Row exists - check if different
      const fieldChanges = getRowDifferences(appRow, matchedSheetRow);

      if (fieldChanges.length > 0) {
        pushResultItem(items, counters, "updated", {
          rowIndex: i,
          productName: appRow.product_name,
          productId: appRow.product_id,
          locationPath: appRow.location_path,
          locationId: appRow.location_id ?? undefined,
          fieldChanges,
        });
      } else {
        pushResultItem(items, counters, "skipped", {
          rowIndex: i,
          productName: appRow.product_name,
          productId: appRow.product_id,
          locationPath: appRow.location_path,
          locationId: appRow.location_id ?? undefined,
        });
      }
    }
  }

  // Find rows in sheet that weren't matched (will be removed)
  // Note: removed items don't have productId since they only exist in the sheet
  for (let i = 0; i < sheetRows.length; i++) {
    if (!matchedSheetIndices.has(i)) {
      const sheetRow = sheetRows[i];
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

/**
 * Removed item with inventory entry ID or product ID for deletion
 */
export interface RemovedInventoryItem extends CSVImportResultItem {
  action: "removed";
  inventoryEntryId?: InventoryId;
  productIdToDelete?: ProductId; // For products completely removed from sheet
}

/**
 * Find items that exist in app but not in sheet (deleted from sheet)
 *
 * Used by pull preview to show what would be deleted, and by apply pull
 * to actually delete the entries.
 *
 * Deletion rules:
 * 1. If a product is completely removed from sheet (no rows reference it) → delete the product
 * 2. If only an inventory entry is removed (product still exists in sheet) → delete only the inventory entry
 *
 * Uses fuzzy manufacturer matching: "(unspecified)" matches any manufacturer.
 */
export function findRemovedInventoryForPull(
  appRows: InventoryCSVExportRow[],
  sheetRows: InventoryCSVRow[],
): RemovedInventoryItem[] {
  const removedItems: RemovedInventoryItem[] = [];

  // Build lookup structures from sheet rows
  // Group by product name (lowercase) for fuzzy product matching
  const sheetProductsByName = new Map<
    string,
    Array<{
      manufacturer: string | undefined;
      locationPath: string | undefined;
    }>
  >();

  for (const row of sheetRows) {
    const nameKey = row.product_name.toLowerCase();
    const existing = sheetProductsByName.get(nameKey) ?? [];
    existing.push({
      manufacturer: row.manufacturer,
      locationPath: row.location_path,
    });
    sheetProductsByName.set(nameKey, existing);
  }

  // Helper to check if product exists in sheet (with fuzzy manufacturer matching)
  const productExistsInSheet = (
    productName: string,
    manufacturer: string | null | undefined,
  ): boolean => {
    const nameKey = productName.toLowerCase();
    const candidates = sheetProductsByName.get(nameKey);
    if (!candidates) return false;

    return candidates.some((c) =>
      manufacturersMatch(manufacturer, c.manufacturer),
    );
  };

  // Helper to check if inventory entry exists in sheet (with fuzzy manufacturer matching)
  const inventoryExistsInSheet = (
    productName: string,
    manufacturer: string | null | undefined,
    locationPath: string,
  ): boolean => {
    const nameKey = productName.toLowerCase();
    const candidates = sheetProductsByName.get(nameKey);
    if (!candidates) return false;

    const normalizedLocation = normalizeLocationPath(locationPath);
    return candidates.some(
      (c) =>
        manufacturersMatch(manufacturer, c.manufacturer) &&
        c.locationPath &&
        normalizeLocationPath(c.locationPath) === normalizedLocation,
    );
  };

  // Track which products we've already marked for deletion (by product_id)
  const productsToDelete = new Set<string>();

  // First pass: identify products that should be completely deleted
  // (products that have no presence in the sheet at all)
  for (const appRow of appRows) {
    if (productsToDelete.has(appRow.product_id)) continue;

    if (!productExistsInSheet(appRow.product_name, appRow.manufacturer)) {
      productsToDelete.add(appRow.product_id);
      removedItems.push({
        rowIndex: -1,
        action: "removed",
        productName: appRow.product_name,
        productId: appRow.product_id,
        productIdToDelete: appRow.product_id,
        message: "Product will be deleted (removed from sheet)",
      });
    }
  }

  // Second pass: identify inventory entries to delete
  // (only for products that still exist in the sheet)
  for (const appRow of appRows) {
    const isProductOnly =
      !appRow.location_path || appRow.location_path.trim() === "";
    if (isProductOnly) continue; // Product-only rows handled above

    // Skip if product is being deleted entirely
    if (productsToDelete.has(appRow.product_id)) continue;

    if (
      !inventoryExistsInSheet(
        appRow.product_name,
        appRow.manufacturer,
        appRow.location_path,
      )
    ) {
      removedItems.push({
        rowIndex: -1,
        action: "removed",
        productName: appRow.product_name,
        productId: appRow.product_id,
        locationPath: appRow.location_path,
        locationId: appRow.location_id ?? undefined,
        inventoryEntryId: appRow.inventory_entry_id ?? undefined,
        message: "Inventory entry will be deleted (removed from sheet)",
      });
    }
  }

  return removedItems;
}
