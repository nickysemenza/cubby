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
} from "~/schemas/inventory";
import { type FieldChange, INVENTORY_CSV_ACTIONS } from "~/schemas/csv";
import type { InventoryCSVExportRow } from "./types";
import {
  createComparisonFunction,
  normalizeForComparison,
  normalizeManufacturer,
  manufacturersMatch,
} from "~/server/repo/csv";
import { type InventoryId, type ProductId } from "~/schemas/identifiers";

/**
 * Create a unique key for inventory comparison (product + manufacturer + location)
 *
 * Uses case-insensitive comparison for product name, manufacturer, and location name.
 */
export function makeInventoryKey(
  productName: string,
  manufacturer: string | null | undefined,
  locationName: string,
): string {
  return `${productName.toLowerCase()}|${normalizeManufacturer(manufacturer).toLowerCase()}|${normalizeForComparison(locationName)}`;
}

/**
 * Create a key for product + location lookup (ignoring manufacturer)
 * Used for fuzzy matching when manufacturer differs
 */
function makeProductLocationKey(
  productName: string,
  locationName: string,
): string {
  return `${productName.toLowerCase()}|${normalizeForComparison(locationName)}`;
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

  // Compare location_name using normalized comparison (lowercase, trimmed)
  const normalizedAppName = normalizeForComparison(appRow.location_name);
  const normalizedSheetName = normalizeForComparison(
    sheetRow.location_name ?? "",
  );
  if (normalizedAppName !== normalizedSheetName) {
    changes.push({
      field: "location",
      from: sheetRow.location_name ?? null,
      to: appRow.location_name,
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
  if ((appRow.product_image ?? "") !== (sheetRow.product_image ?? "")) {
    changes.push({
      field: "product_image",
      from: sheetRow.product_image ?? null,
      to: appRow.product_image ?? null,
    });
  }

  return changes;
}

/**
 * Internal comparison function using shared framework
 *
 * Uses fuzzy manufacturer matching: "(unspecified)" matches any manufacturer.
 */
const compareInventoryInternal = createComparisonFunction<
  InventoryCSVExportRow,
  InventoryCSVRow,
  CSVImportResultItem,
  (typeof INVENTORY_CSV_ACTIONS)[number]
>({
  actions: INVENTORY_CSV_ACTIONS,

  // Use product+location as key (ignoring manufacturer for initial lookup)
  getSheetKey: (row) =>
    makeProductLocationKey(row.product_name, row.location_name ?? ""),
  getAppKey: (row) =>
    makeProductLocationKey(row.product_name, row.location_name),

  // Custom matching with fuzzy manufacturer logic
  findMatch: (appRow, candidates, matchedIndices, allSheetRows) => {
    for (const candidate of candidates) {
      const sheetIndex = allSheetRows.indexOf(candidate);

      // Skip already matched rows
      if (matchedIndices.has(sheetIndex)) continue;

      // Check if manufacturers are compatible
      if (manufacturersMatch(appRow.manufacturer, candidate.manufacturer)) {
        return { row: candidate, index: sheetIndex };
      }
    }
    return undefined;
  },

  getDifferences: getRowDifferences,

  buildCreatedItem: (rowIndex, appRow) => ({
    rowIndex,
    action: "created",
    productName: appRow.product_name,
    productId: appRow.product_id,
    locationName: appRow.location_name,
    locationId: appRow.location_id ?? undefined,
    message: "Will be added to sheet",
  }),

  buildUpdatedItem: (rowIndex, appRow, fieldChanges) => ({
    rowIndex,
    action: "updated",
    productName: appRow.product_name,
    productId: appRow.product_id,
    locationName: appRow.location_name,
    locationId: appRow.location_id ?? undefined,
    fieldChanges,
  }),

  buildSkippedItem: (rowIndex, appRow) => ({
    rowIndex,
    action: "skipped",
    productName: appRow.product_name,
    productId: appRow.product_id,
    locationName: appRow.location_name,
    locationId: appRow.location_id ?? undefined,
  }),

  buildRemovedItem: (sheetRow) => ({
    rowIndex: -1,
    action: "removed",
    productName: sheetRow.product_name,
    locationName: sheetRow.location_name ?? undefined,
    message: "Will be removed from sheet",
  }),

  createdAction: "created",
  updatedAction: "updated",
  skippedAction: "skipped",
  removedAction: "removed",
});

/**
 * Detect renames by matching created (app→sheet) and removed (sheet→app) items
 *
 * Uses multiple heuristics to pair items:
 * 1. UPC match - same UPC, different name (highest confidence)
 * 2. Name containment - one name contains the other (e.g., "misc: X" contains "X")
 * 3. Location match - same non-empty location (lower confidence, used when other signals present)
 *
 * Returns modified items list and rename count.
 */
function detectRenames(
  items: CSVImportResultItem[],
  appRows: InventoryCSVExportRow[],
  sheetRows: InventoryCSVRow[],
): { items: CSVImportResultItem[]; renameCount: number } {
  // Separate created and removed items
  const createdItems = items.filter((item) => item.action === "created");
  const removedItems = items.filter((item) => item.action === "removed");
  const otherItems = items.filter(
    (item) => item.action !== "created" && item.action !== "removed",
  );

  // Build lookup maps for detailed row data
  const appRowsByName = new Map<string, InventoryCSVExportRow>();
  for (const row of appRows) {
    appRowsByName.set(row.product_name.toLowerCase(), row);
  }

  const sheetRowsByName = new Map<string, InventoryCSVRow>();
  for (const row of sheetRows) {
    sheetRowsByName.set(row.product_name.toLowerCase(), row);
  }

  // Track which items have been paired
  const pairedCreatedIndices = new Set<number>();
  const pairedRemovedIndices = new Set<number>();
  const renamedItems: CSVImportResultItem[] = [];

  // Score potential pairs based on heuristics
  interface RenamePair {
    createdIdx: number;
    removedIdx: number;
    score: number;
    reason: string;
  }

  const potentialPairs: RenamePair[] = [];

  for (let ci = 0; ci < createdItems.length; ci++) {
    const created = createdItems[ci];
    const appRow = appRowsByName.get(created.productName.toLowerCase());
    if (!appRow) continue;

    for (let ri = 0; ri < removedItems.length; ri++) {
      const removed = removedItems[ri];
      const sheetRow = sheetRowsByName.get(removed.productName.toLowerCase());
      if (!sheetRow) continue;

      let score = 0;
      const reasons: string[] = [];

      // Heuristic 1: UPC match (highest weight)
      const appUpc = appRow.upc?.trim();
      const sheetUpc = sheetRow.upc?.trim();
      if (appUpc && sheetUpc && appUpc === sheetUpc) {
        score += 100;
        reasons.push("UPC");
      }

      // Heuristic 2: Name containment (with punctuation normalization)
      const createdNameLower = created.productName.toLowerCase();
      const removedNameLower = removed.productName.toLowerCase();
      // Skip if names are identical - this is NOT a rename
      if (createdNameLower === removedNameLower) {
        continue;
      }
      // Normalize punctuation for fuzzy matching (e.g., "misc:" vs "misc.")
      const normalizeForFuzzy = (s: string) =>
        s
          .replace(/[:.;,]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const createdNormalized = normalizeForFuzzy(createdNameLower);
      const removedNormalized = normalizeForFuzzy(removedNameLower);
      // Skip if normalized names are identical - this is NOT a rename
      if (createdNormalized === removedNormalized) {
        continue;
      }
      if (
        createdNameLower.includes(removedNameLower) ||
        removedNameLower.includes(createdNameLower) ||
        createdNormalized.includes(removedNormalized) ||
        removedNormalized.includes(createdNormalized)
      ) {
        score += 50;
        reasons.push("name");
      }

      // Heuristic 3: Same location
      const createdLoc = normalizeForComparison(created.locationName ?? "");
      const removedLoc = normalizeForComparison(removed.locationName ?? "");
      if (createdLoc && removedLoc && createdLoc === removedLoc) {
        score += 25;
        reasons.push("location");
      }

      // Heuristic 4: Same manufacturer
      if (
        manufacturersMatch(appRow.manufacturer, sheetRow.manufacturer) &&
        appRow.manufacturer !== "(unspecified)"
      ) {
        score += 10;
        reasons.push("manufacturer");
      }

      // Only consider as rename if at least one strong signal
      if (score >= 50) {
        potentialPairs.push({
          createdIdx: ci,
          removedIdx: ri,
          score,
          reason: reasons.join("+"),
        });
      }
    }
  }

  // Sort by score (highest first) and greedily match
  potentialPairs.sort((a, b) => b.score - a.score);

  for (const pair of potentialPairs) {
    if (
      pairedCreatedIndices.has(pair.createdIdx) ||
      pairedRemovedIndices.has(pair.removedIdx)
    ) {
      continue;
    }

    pairedCreatedIndices.add(pair.createdIdx);
    pairedRemovedIndices.add(pair.removedIdx);

    const created = createdItems[pair.createdIdx];
    const removed = removedItems[pair.removedIdx];

    // Create renamed item
    renamedItems.push({
      rowIndex: created.rowIndex,
      action: "renamed",
      productName: created.productName,
      productId: created.productId,
      locationName: created.locationName,
      locationId: created.locationId,
      renamedFrom: removed.productName,
      message: `Renamed from "${removed.productName}" (matched by ${pair.reason})`,
    });
  }

  // Keep unpaired items as-is
  const unpairedCreated = createdItems.filter(
    (_, i) => !pairedCreatedIndices.has(i),
  );
  const unpairedRemoved = removedItems.filter(
    (_, i) => !pairedRemovedIndices.has(i),
  );

  return {
    items: [
      ...otherItems,
      ...unpairedCreated,
      ...unpairedRemoved,
      ...renamedItems,
    ],
    renameCount: renamedItems.length,
  };
}

/**
 * Compare app inventory rows with sheet rows to generate a diff preview
 *
 * Used by push preview to show what changes would be made to the sheet,
 * and by round-trip tests to verify export/import symmetry.
 *
 * Uses fuzzy manufacturer matching: "(unspecified)" matches any manufacturer.
 * Detects renames using UPC matching, name containment, and location matching.
 */
export function compareInventoryForPush(
  appRows: InventoryCSVExportRow[],
  sheetRows: InventoryCSVRow[],
): CSVImportResult {
  const result = compareInventoryInternal(appRows, sheetRows);

  // Detect renames from created/removed pairs
  const { items: itemsWithRenames, renameCount } = detectRenames(
    result.items,
    appRows,
    sheetRows,
  );

  // Adjust counters: renames reduce both created and removed counts
  const adjustedCreated = result.created - renameCount;
  const adjustedRemoved = result.removed - renameCount;

  // Map to CSVImportResult format (legacy counter names)
  return {
    created: adjustedCreated,
    moved: result.moved,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.error,
    productOnly: result.product_only,
    removed: adjustedRemoved > 0 ? adjustedRemoved : undefined,
    renamed: renameCount > 0 ? renameCount : undefined,
    items: itemsWithRenames,
  };
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
    location_name: row.location_name || undefined,
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
      locationName: string | undefined;
    }>
  >();

  for (const row of sheetRows) {
    const nameKey = row.product_name.toLowerCase();
    const existing = sheetProductsByName.get(nameKey) ?? [];
    existing.push({
      manufacturer: row.manufacturer,
      locationName: row.location_name,
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
    locationName: string,
  ): boolean => {
    const nameKey = productName.toLowerCase();
    const candidates = sheetProductsByName.get(nameKey);
    if (!candidates) return false;

    const normalizedLocation = normalizeForComparison(locationName);
    return candidates.some(
      (c) =>
        manufacturersMatch(manufacturer, c.manufacturer) &&
        c.locationName &&
        normalizeForComparison(c.locationName) === normalizedLocation,
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

  // Build counts for move detection
  // Count inventory entries per product in app (by product_id)
  const appEntriesPerProduct = new Map<string, number>();
  for (const appRow of appRows) {
    if (appRow.location_name && appRow.location_name.trim() !== "") {
      appEntriesPerProduct.set(
        appRow.product_id,
        (appEntriesPerProduct.get(appRow.product_id) ?? 0) + 1,
      );
    }
  }

  // Count inventory entries per product in sheet (by product name + manufacturer)
  const sheetEntriesPerProduct = new Map<string, number>();
  for (const row of sheetRows) {
    if (row.location_name && row.location_name.trim() !== "") {
      const key = `${row.product_name.toLowerCase()}|${normalizeManufacturer(row.manufacturer).toLowerCase()}`;
      sheetEntriesPerProduct.set(
        key,
        (sheetEntriesPerProduct.get(key) ?? 0) + 1,
      );
    }
  }

  // Second pass: identify inventory entries to delete
  // (only for products that still exist in the sheet)
  for (const appRow of appRows) {
    const isProductOnly =
      !appRow.location_name || appRow.location_name.trim() === "";
    if (isProductOnly) continue; // Product-only rows handled above

    // Skip if product is being deleted entirely
    if (productsToDelete.has(appRow.product_id)) continue;

    if (
      !inventoryExistsInSheet(
        appRow.product_name,
        appRow.manufacturer,
        appRow.location_name,
      )
    ) {
      // Check if this is a "move" scenario: product has exactly 1 entry in app
      // and exactly 1 entry in sheet (at a different location)
      // In this case, the import logic will handle it as a move, not a removal
      const appEntryCount = appEntriesPerProduct.get(appRow.product_id) ?? 0;
      const sheetKey = `${appRow.product_name.toLowerCase()}|${normalizeManufacturer(appRow.manufacturer).toLowerCase()}`;
      const sheetEntryCount = sheetEntriesPerProduct.get(sheetKey) ?? 0;

      if (appEntryCount === 1 && sheetEntryCount === 1) {
        // This is a 1-to-1 move scenario - import will handle it as a move
        continue;
      }

      removedItems.push({
        rowIndex: -1,
        action: "removed",
        productName: appRow.product_name,
        productId: appRow.product_id,
        locationName: appRow.location_name,
        locationId: appRow.location_id ?? undefined,
        inventoryEntryId: appRow.inventory_entry_id ?? undefined,
        message: "Inventory entry will be deleted (removed from sheet)",
      });
    }
  }

  return removedItems;
}

/**
 * Detect renames for pull operation by matching created (from sheet) with removed (from app) items
 *
 * For pull:
 * - "created" = new product from sheet that will be created in app
 * - "removed" = old product in app that will be deleted
 *
 * Uses same heuristics as push rename detection:
 * 1. UPC match - same UPC, different name (highest confidence)
 * 2. Name containment - one name contains the other
 * 3. Location match - same non-empty location
 *
 * Returns modified items list with renames detected.
 */
export function detectRenamesForPull(
  items: CSVImportResultItem[],
  sheetRows: InventoryCSVRow[],
  appRows: InventoryCSVExportRow[],
): { items: CSVImportResultItem[]; renameCount: number } {
  // Separate created and removed items
  const createdItems = items.filter((item) => item.action === "created");
  const removedItems = items.filter((item) => item.action === "removed");
  const otherItems = items.filter(
    (item) => item.action !== "created" && item.action !== "removed",
  );

  // Build lookup maps for detailed row data
  // For pull: sheet has the new names (created), app has the old names (removed)
  const sheetRowsByName = new Map<string, InventoryCSVRow>();
  for (const row of sheetRows) {
    sheetRowsByName.set(row.product_name.toLowerCase(), row);
  }

  const appRowsByName = new Map<string, InventoryCSVExportRow>();
  for (const row of appRows) {
    appRowsByName.set(row.product_name.toLowerCase(), row);
  }

  // Track which items have been paired
  const pairedCreatedIndices = new Set<number>();
  const pairedRemovedIndices = new Set<number>();
  const renamedItems: CSVImportResultItem[] = [];

  // Score potential pairs based on heuristics
  interface RenamePair {
    createdIdx: number;
    removedIdx: number;
    score: number;
    reason: string;
  }

  const potentialPairs: RenamePair[] = [];

  for (let ci = 0; ci < createdItems.length; ci++) {
    const created = createdItems[ci];
    // For pull: created items come from sheet
    const sheetRow = sheetRowsByName.get(created.productName.toLowerCase());
    if (!sheetRow) continue;

    for (let ri = 0; ri < removedItems.length; ri++) {
      const removed = removedItems[ri];
      // For pull: removed items come from app
      const appRow = appRowsByName.get(removed.productName.toLowerCase());
      if (!appRow) continue;

      let score = 0;
      const reasons: string[] = [];

      // Heuristic 1: UPC match (highest weight)
      const sheetUpc = sheetRow.upc?.trim();
      const appUpc = appRow.upc?.trim();
      if (sheetUpc && appUpc && sheetUpc === appUpc) {
        score += 100;
        reasons.push("UPC");
      }

      // Heuristic 2: Name containment (with punctuation normalization)
      const createdNameLower = created.productName.toLowerCase();
      const removedNameLower = removed.productName.toLowerCase();
      // Skip if names are identical - this is NOT a rename
      if (createdNameLower === removedNameLower) {
        continue;
      }
      // Normalize punctuation for fuzzy matching (e.g., "misc:" vs "misc.")
      const normalizeForFuzzy = (s: string) =>
        s
          .replace(/[:.;,]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const createdNormalized = normalizeForFuzzy(createdNameLower);
      const removedNormalized = normalizeForFuzzy(removedNameLower);
      // Skip if normalized names are identical - this is NOT a rename
      if (createdNormalized === removedNormalized) {
        continue;
      }
      if (
        createdNameLower.includes(removedNameLower) ||
        removedNameLower.includes(createdNameLower) ||
        createdNormalized.includes(removedNormalized) ||
        removedNormalized.includes(createdNormalized)
      ) {
        score += 50;
        reasons.push("name");
      }

      // Heuristic 3: Same location
      const createdLoc = normalizeForComparison(created.locationName ?? "");
      const removedLoc = normalizeForComparison(removed.locationName ?? "");
      if (createdLoc && removedLoc && createdLoc === removedLoc) {
        score += 25;
        reasons.push("location");
      }

      // Heuristic 4: Same manufacturer
      if (
        manufacturersMatch(sheetRow.manufacturer, appRow.manufacturer) &&
        appRow.manufacturer !== "(unspecified)"
      ) {
        score += 10;
        reasons.push("manufacturer");
      }

      // Only consider as rename if at least one strong signal
      if (score >= 50) {
        potentialPairs.push({
          createdIdx: ci,
          removedIdx: ri,
          score,
          reason: reasons.join("+"),
        });
      }
    }
  }

  // Sort by score (highest first) and greedily match
  potentialPairs.sort((a, b) => b.score - a.score);

  for (const pair of potentialPairs) {
    if (
      pairedCreatedIndices.has(pair.createdIdx) ||
      pairedRemovedIndices.has(pair.removedIdx)
    ) {
      continue;
    }

    pairedCreatedIndices.add(pair.createdIdx);
    pairedRemovedIndices.add(pair.removedIdx);

    const created = createdItems[pair.createdIdx];
    const removed = removedItems[pair.removedIdx];

    // Create renamed item - for pull, the new name is from sheet (created)
    renamedItems.push({
      rowIndex: created.rowIndex,
      action: "renamed",
      productName: created.productName, // New name (from sheet)
      productId: removed.productId, // Keep the existing product ID
      locationName: created.locationName,
      locationId: created.locationId ?? removed.locationId,
      renamedFrom: removed.productName, // Old name (from app)
      message: `Renamed from "${removed.productName}" (matched by ${pair.reason})`,
    });
  }

  // Keep unpaired items as-is
  const unpairedCreated = createdItems.filter(
    (_, i) => !pairedCreatedIndices.has(i),
  );
  const unpairedRemoved = removedItems.filter(
    (_, i) => !pairedRemovedIndices.has(i),
  );

  return {
    items: [
      ...otherItems,
      ...unpairedCreated,
      ...unpairedRemoved,
      ...renamedItems,
    ],
    renameCount: renamedItems.length,
  };
}
