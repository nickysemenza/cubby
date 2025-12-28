/**
 * Unified sync comparison logic
 *
 * Compares app and sheet data to classify items into sync states.
 * Used by the omnidirectional sync feature.
 */

import {
  isUnspecifiedManufacturer,
  normalizeManufacturer,
} from "~/lib/manufacturer-utils";
import type { InventoryCSVRow } from "~/schemas/inventory";
import type { LocationCSVRow } from "~/schemas/location";
import type { ProductCategory } from "~/schemas/product";
import {
  getDefaultResolution,
  type InventorySyncItem,
  type LocationSyncItem,
  type SyncState,
} from "~/schemas/sync";
import { normalizeForComparison } from "~/server/repo/csv/normalize";
import { getRowDifferences as getInventoryRowDifferences } from "~/server/repo/inventory/csv-comparison";
import type { InventoryCSVExportRow } from "~/server/repo/inventory/types";
import { getLocationRowDifferences } from "~/server/repo/location/csv-comparison";
import type { LocationCSVExportRow } from "~/server/repo/location/types";

/**
 * Common inventory row fields (snake_case → camelCase)
 */
type InventoryRowLike = {
  product_name: string;
  manufacturer?: string | null;
  category?: ProductCategory | null;
  location_name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  upc?: string | null;
  model?: string | null;
  ndb_number?: number | null;
  expected_qty?: number | null;
  price?: number | null;
  unit_mappings?: string | null;
  ingredient_name?: string | null;
  aliases?: string | null;
  product_image?: string | null;
};

const buildInventorySyncFields = (row: InventoryRowLike) => ({
  productName: row.product_name,
  manufacturer: row.manufacturer ?? null,
  category: row.category ?? null,
  locationName: row.location_name ?? null,
  quantity: row.quantity ?? null,
  unit: row.unit ?? null,
  upc: row.upc ?? null,
  model: row.model ?? null,
  ndbNumber: row.ndb_number ?? null,
  expectedQty: row.expected_qty ?? null,
  price: row.price ?? null,
  unitMappings: row.unit_mappings ?? null,
  ingredientName: row.ingredient_name ?? null,
  aliases: row.aliases ?? null,
  productImage: row.product_image ?? null,
});

/** Build appData object from an inventory export row (adds IDs) */
const buildInventoryAppData = (row: InventoryCSVExportRow) => ({
  ...buildInventorySyncFields(row),
  productId: row.product_id,
  locationId: row.location_id,
  inventoryEntryId: row.inventory_entry_id,
});

/** Build sheetData object from an inventory CSV row */
const buildInventorySheetData = (row: InventoryCSVRow) =>
  buildInventorySyncFields(row);

/** Common location row fields (snake_case → camelCase) */
type LocationRowLike = {
  location_name: string;
  parent_name?: string | null;
  location_type?: string;
  description?: string | null;
  location_image?: string | null;
  last_inventory_date?: string | null;
};

const buildLocationSyncFields = (row: LocationRowLike) => ({
  locationName: row.location_name,
  parentName: row.parent_name ?? null,
  locationType: row.location_type ?? "other",
  description: row.description ?? null,
  locationImage: row.location_image ?? null,
  lastInventoryDate: row.last_inventory_date ?? null,
});

/** Build appData object from a location export row (adds ID) */
const buildLocationAppData = (row: LocationCSVExportRow) => ({
  ...buildLocationSyncFields(row),
  locationId: row.location_id,
});

/** Build sheetData object from a location CSV row */
const buildLocationSheetData = (row: LocationCSVRow) =>
  buildLocationSyncFields(row);

/**
 * Compare locations between app and sheet
 */
export function compareLocationsForSync(
  appRows: LocationCSVExportRow[],
  sheetRows: LocationCSVRow[],
): LocationSyncItem[] {
  const items: LocationSyncItem[] = [];

  // Build maps by normalized name
  const appByKey = new Map<string, LocationCSVExportRow>();
  const sheetByKey = new Map<string, LocationCSVRow>();

  for (const row of appRows) {
    const key = normalizeForComparison(row.location_name);
    appByKey.set(key, row);
  }

  for (const row of sheetRows) {
    const key = normalizeForComparison(row.location_name);
    sheetByKey.set(key, row);
  }

  // Track processed keys
  const processedKeys = new Set<string>();

  // First pass: exact matches and conflicts
  for (const [key, appRow] of appByKey) {
    const sheetRow = sheetByKey.get(key);

    if (sheetRow) {
      const fieldDiffs = getLocationRowDifferences(appRow, sheetRow);
      const state: SyncState = fieldDiffs.length > 0 ? "conflict" : "matched";
      const defaultResolution = getDefaultResolution(state, fieldDiffs);

      items.push({
        entityType: "location",
        key,
        state,
        defaultResolution,
        resolution: defaultResolution,
        fieldDiffs: fieldDiffs.length > 0 ? fieldDiffs : undefined,
        appData: buildLocationAppData(appRow),
        sheetData: buildLocationSheetData(sheetRow),
      });

      processedKeys.add(key);
    }
  }

  // Second pass: detect renames (app_only + sheet_only with matching attributes)
  const unprocessedApp = [...appByKey.entries()].filter(
    ([key]) => !processedKeys.has(key),
  );
  const unprocessedSheet = [...sheetByKey.entries()].filter(
    ([key]) => !processedKeys.has(key),
  );

  // Score potential rename pairs
  interface LocationRenamePair {
    appKey: string;
    sheetKey: string;
    appRow: LocationCSVExportRow;
    sheetRow: LocationCSVRow;
    score: number;
    reason: string;
  }

  const potentialPairs: LocationRenamePair[] = [];

  for (const [appKey, appRow] of unprocessedApp) {
    for (const [sheetKey, sheetRow] of unprocessedSheet) {
      let score = 0;
      const reasons: string[] = [];

      // Names must be different for it to be a rename
      const appName = normalizeForComparison(appRow.location_name);
      const sheetName = normalizeForComparison(sheetRow.location_name);
      if (appName === sheetName) continue;

      // Heuristic 1: Description match (strong signal if non-empty)
      const appDesc = (appRow.description ?? "").trim().toLowerCase();
      const sheetDesc = (sheetRow.description ?? "").trim().toLowerCase();
      if (appDesc && sheetDesc && appDesc === sheetDesc) {
        score += 100;
        reasons.push("description");
      }

      // Heuristic 2: Same parent AND same type (strong together)
      const appParent = normalizeForComparison(appRow.parent_name ?? "");
      const sheetParent = normalizeForComparison(sheetRow.parent_name ?? "");
      const parentMatch = appParent === sheetParent;

      const appType = appRow.location_type;
      const sheetType = sheetRow.location_type;
      const typeMatch = appType === sheetType;

      if (parentMatch && typeMatch) {
        score += 60;
        reasons.push("parent+type");
      } else if (parentMatch) {
        score += 30;
        reasons.push("parent");
      } else if (typeMatch) {
        score += 10;
        reasons.push("type");
      }

      // Heuristic 3: Name containment
      const appNameLower = appRow.location_name.toLowerCase();
      const sheetNameLower = sheetRow.location_name.toLowerCase();
      if (
        appNameLower.includes(sheetNameLower) ||
        sheetNameLower.includes(appNameLower)
      ) {
        score += 40;
        reasons.push("name");
      }

      // Require meaningful signal (description match, or parent+type, or name containment with parent)
      if (score >= 40) {
        potentialPairs.push({
          appKey,
          sheetKey,
          appRow,
          sheetRow,
          score,
          reason: reasons.join(" + "),
        });
      }
    }
  }

  // Sort by score descending and greedily match
  potentialPairs.sort((a, b) => b.score - a.score);

  for (const pair of potentialPairs) {
    if (processedKeys.has(pair.appKey) || processedKeys.has(pair.sheetKey)) {
      continue;
    }

    const defaultResolution = getDefaultResolution("renamed");

    items.push({
      entityType: "location",
      key: pair.appKey,
      state: "renamed",
      defaultResolution,
      resolution: defaultResolution,
      appData: buildLocationAppData(pair.appRow),
      sheetData: buildLocationSheetData(pair.sheetRow),
      renamedFrom: pair.appRow.location_name,
      renamedTo: pair.sheetRow.location_name,
    });

    processedKeys.add(pair.appKey);
    processedKeys.add(pair.sheetKey);
  }

  // Third pass: app_only items
  for (const [key, appRow] of appByKey) {
    if (processedKeys.has(key)) continue;

    const defaultResolution = getDefaultResolution("app_only");

    items.push({
      entityType: "location",
      key,
      state: "app_only",
      defaultResolution,
      resolution: defaultResolution,
      appData: buildLocationAppData(appRow),
      sheetData: null,
    });

    processedKeys.add(key);
  }

  // Fourth pass: sheet_only items
  for (const [key, sheetRow] of sheetByKey) {
    if (processedKeys.has(key)) continue;

    const defaultResolution = getDefaultResolution("sheet_only");

    items.push({
      entityType: "location",
      key,
      state: "sheet_only",
      defaultResolution,
      resolution: defaultResolution,
      appData: null,
      sheetData: buildLocationSheetData(sheetRow),
    });

    processedKeys.add(key);
  }

  return items;
}

/**
 * Create inventory key from product, manufacturer, location
 */
const makeInventoryKey = (
  productName: string,
  manufacturer: string | null | undefined,
  locationName: string | null | undefined,
): string => {
  const normProduct = normalizeForComparison(productName);
  // normalizeManufacturer returns "(unspecified)" for empty, lowercase for key matching
  const normManufacturer = normalizeManufacturer(manufacturer).toLowerCase();
  const normLocation = normalizeForComparison(locationName ?? "");
  return `${normProduct}|${normManufacturer}|${normLocation}`;
};

/**
 * Compare inventory between app and sheet
 */
export function compareInventoryForSync(
  appRows: InventoryCSVExportRow[],
  sheetRows: InventoryCSVRow[],
): InventorySyncItem[] {
  const items: InventorySyncItem[] = [];

  // Build maps by key
  const appByKey = new Map<string, InventoryCSVExportRow>();
  const sheetByKey = new Map<string, InventoryCSVRow>();

  // Also track by product name for move/rename detection
  const appByProduct = new Map<string, InventoryCSVExportRow[]>();
  const sheetByProduct = new Map<string, InventoryCSVRow[]>();

  for (const row of appRows) {
    const key = makeInventoryKey(
      row.product_name,
      row.manufacturer,
      row.location_name,
    );
    appByKey.set(key, row);

    const productKey = normalizeForComparison(row.product_name);
    const existing = appByProduct.get(productKey) ?? [];
    existing.push(row);
    appByProduct.set(productKey, existing);
  }

  for (const row of sheetRows) {
    const key = makeInventoryKey(
      row.product_name,
      row.manufacturer,
      row.location_name,
    );
    sheetByKey.set(key, row);

    const productKey = normalizeForComparison(row.product_name);
    const existing = sheetByProduct.get(productKey) ?? [];
    existing.push(row);
    sheetByProduct.set(productKey, existing);
  }

  // Track processed keys to avoid duplicates
  const processedKeys = new Set<string>();

  // First pass: exact matches and conflicts
  for (const [key, appRow] of appByKey) {
    const sheetRow = sheetByKey.get(key);

    if (sheetRow) {
      // Exists in both - check for differences
      const fieldDiffs = getInventoryRowDifferences(appRow, sheetRow);
      const state: SyncState = fieldDiffs.length > 0 ? "conflict" : "matched";
      const defaultResolution = getDefaultResolution(state, fieldDiffs);

      items.push({
        entityType: "inventory",
        key,
        state,
        defaultResolution,
        resolution: defaultResolution,
        fieldDiffs: fieldDiffs.length > 0 ? fieldDiffs : undefined,
        appData: buildInventoryAppData(appRow),
        sheetData: buildInventorySheetData(sheetRow),
      });

      processedKeys.add(key);
    }
  }

  // Second pass: detect moves (same product, different location) or manufacturer changes
  for (const [key, appRow] of appByKey) {
    if (processedKeys.has(key)) continue;

    const productKey = normalizeForComparison(appRow.product_name);
    const appEntriesForProduct = appByProduct.get(productKey) ?? [];
    const sheetEntriesForProduct = sheetByProduct.get(productKey) ?? [];

    // Check for move or manufacturer change: 1 entry in app, 1 entry in sheet
    if (
      appEntriesForProduct.length === 1 &&
      sheetEntriesForProduct.length === 1
    ) {
      const sheetRow = sheetEntriesForProduct[0]!;
      const sheetKey = makeInventoryKey(
        sheetRow.product_name,
        sheetRow.manufacturer,
        sheetRow.location_name,
      );

      const sameLocation =
        normalizeForComparison(appRow.location_name ?? "") ===
        normalizeForComparison(sheetRow.location_name ?? "");
      const sameManufacturer =
        normalizeManufacturer(appRow.manufacturer).toLowerCase() ===
        normalizeManufacturer(sheetRow.manufacturer).toLowerCase();

      // Different locations = move
      if (!sameLocation) {
        const defaultResolution = getDefaultResolution("moved");

        items.push({
          entityType: "inventory",
          key, // Use app key
          state: "moved",
          defaultResolution,
          resolution: defaultResolution,
          appData: buildInventoryAppData(appRow),
          sheetData: buildInventorySheetData(sheetRow),
          movedFrom: appRow.location_name ?? undefined,
          movedTo: sheetRow.location_name ?? undefined,
        });

        processedKeys.add(key);
        processedKeys.add(sheetKey);
      } else if (!sameManufacturer) {
        // Same location, different manufacturer = conflict on manufacturer field
        const fieldDiffs = getInventoryRowDifferences(appRow, sheetRow);
        const defaultResolution = getDefaultResolution("conflict", fieldDiffs);

        items.push({
          entityType: "inventory",
          key, // Use app key
          state: "conflict",
          defaultResolution,
          resolution: defaultResolution,
          fieldDiffs: fieldDiffs.length > 0 ? fieldDiffs : undefined,
          appData: buildInventoryAppData(appRow),
          sheetData: buildInventorySheetData(sheetRow),
        });

        processedKeys.add(key);
        processedKeys.add(sheetKey);
      }
    }
  }

  // Pass 2.5: UPC-based matching for same-name products with multiple entries
  // This handles cases where there are multiple products with the same name but
  // we can uniquely identify them by UPC
  for (const [key, appRow] of appByKey) {
    if (processedKeys.has(key)) continue;

    const appUpc = appRow.upc?.trim();
    if (!appUpc) continue; // Need UPC for this pass

    // Find unprocessed sheet row with matching UPC and same product name
    for (const [sheetKey, sheetRow] of sheetByKey) {
      if (processedKeys.has(sheetKey)) continue;

      const sheetUpc = sheetRow.upc?.trim();
      if (sheetUpc !== appUpc) continue;

      // UPC matches - check if product names also match (same product, just different key)
      const appName = normalizeForComparison(appRow.product_name);
      const sheetName = normalizeForComparison(sheetRow.product_name);
      if (appName !== sheetName) continue; // Different product names go to rename detection

      // Same product name + same UPC = definitely the same item
      // Detect field differences (likely manufacturer change)
      const fieldDiffs = getInventoryRowDifferences(appRow, sheetRow);

      const sameLocation =
        normalizeForComparison(appRow.location_name ?? "") ===
        normalizeForComparison(sheetRow.location_name ?? "");

      if (!sameLocation) {
        // Location changed = move
        const defaultResolution = getDefaultResolution("moved");

        items.push({
          entityType: "inventory",
          key,
          state: "moved",
          defaultResolution,
          resolution: defaultResolution,
          appData: buildInventoryAppData(appRow),
          sheetData: buildInventorySheetData(sheetRow),
          movedFrom: appRow.location_name ?? undefined,
          movedTo: sheetRow.location_name ?? undefined,
        });
      } else if (fieldDiffs.length > 0) {
        // Same location but other field differences = conflict
        const defaultResolution = getDefaultResolution("conflict", fieldDiffs);

        items.push({
          entityType: "inventory",
          key,
          state: "conflict",
          defaultResolution,
          resolution: defaultResolution,
          fieldDiffs,
          appData: buildInventoryAppData(appRow),
          sheetData: buildInventorySheetData(sheetRow),
        });
      } else {
        // Exact match (shouldn't happen if keys are built correctly, but handle it)
        items.push({
          entityType: "inventory",
          key,
          state: "matched",
          defaultResolution: null,
          resolution: null,
          appData: buildInventoryAppData(appRow),
          sheetData: buildInventorySheetData(sheetRow),
        });
      }

      processedKeys.add(key);
      processedKeys.add(sheetKey);
      break; // Found match for this app row
    }
  }

  // Third pass: detect renames (app_only + sheet_only with matching attributes)
  const unprocessedApp = [...appByKey.entries()].filter(
    ([key]) => !processedKeys.has(key),
  );
  const unprocessedSheet = [...sheetByKey.entries()].filter(
    ([key]) => !processedKeys.has(key),
  );

  // Score potential rename pairs
  interface RenamePair {
    appKey: string;
    sheetKey: string;
    appRow: InventoryCSVExportRow;
    sheetRow: InventoryCSVRow;
    score: number;
    reason: string;
  }

  const potentialPairs: RenamePair[] = [];

  for (const [appKey, appRow] of unprocessedApp) {
    for (const [sheetKey, sheetRow] of unprocessedSheet) {
      let score = 0;
      const reasons: string[] = [];

      // Names must be different for it to be a rename
      const appName = normalizeForComparison(appRow.product_name);
      const sheetName = normalizeForComparison(sheetRow.product_name);
      if (appName === sheetName) continue;

      // Heuristic 1: UPC match (highest weight - definitive identifier)
      const appUpc = appRow.upc?.trim();
      const sheetUpc = sheetRow.upc?.trim();
      const upcMatch = appUpc && sheetUpc && appUpc === sheetUpc;
      if (upcMatch) {
        score += 100;
        reasons.push("UPC");
      }

      // Heuristic 2: Model match (strong identifier)
      const appModel = appRow.model?.trim();
      const sheetModel = sheetRow.model?.trim();
      const modelMatch = appModel && sheetModel && appModel === sheetModel;
      if (modelMatch) {
        score += 80;
        reasons.push("model");
      }

      // Track if we have a definitive identifier match
      const hasDefinitiveIdentifier = upcMatch || modelMatch;

      // Heuristic 3: Name containment
      const appNameLower = appRow.product_name.toLowerCase();
      const sheetNameLower = sheetRow.product_name.toLowerCase();
      if (
        appNameLower.includes(sheetNameLower) ||
        sheetNameLower.includes(appNameLower)
      ) {
        score += 50;
        reasons.push("name");
      }

      // Heuristic 4: Same location
      const appLoc = normalizeForComparison(appRow.location_name ?? "");
      const sheetLoc = normalizeForComparison(sheetRow.location_name ?? "");
      const sameLocation = appLoc && sheetLoc && appLoc === sheetLoc;
      if (sameLocation) {
        score += 25;
        reasons.push("location");
      }

      // Heuristic 5: Manufacturer matching
      const appMfr = normalizeManufacturer(appRow.manufacturer).toLowerCase();
      const sheetMfr = normalizeManufacturer(
        sheetRow.manufacturer,
      ).toLowerCase();
      const manufacturersMatch = appMfr === sheetMfr;
      const appHasSpecificMfr = !isUnspecifiedManufacturer(appMfr);
      const sheetHasSpecificMfr = !isUnspecifiedManufacturer(sheetMfr);

      if (manufacturersMatch && appHasSpecificMfr) {
        // Both have same specific manufacturer - bonus
        score += 10;
        reasons.push("manufacturer");
      } else if (
        appHasSpecificMfr &&
        sheetHasSpecificMfr &&
        !manufacturersMatch &&
        !hasDefinitiveIdentifier
      ) {
        // Both have DIFFERENT specific manufacturers - strong signal against rename
        // BUT: skip penalty if UPC/model matches (those are definitive)
        score -= 60;
        reasons.push("different-manufacturers");
      }

      // Heuristic 6: Same location + same manufacturer is a strong signal
      // (likely a rename if both match - even if both are unspecified)
      if (sameLocation && manufacturersMatch) {
        score += 30;
        reasons.push("location+manufacturer");
      }

      // Require at least one strong signal (UPC, model, name containment, or location+manufacturer)
      if (score >= 50) {
        potentialPairs.push({
          appKey,
          sheetKey,
          appRow,
          sheetRow,
          score,
          reason: reasons.join(" + "),
        });
      }
    }
  }

  // Sort by score descending and greedily match
  potentialPairs.sort((a, b) => b.score - a.score);

  for (const pair of potentialPairs) {
    if (processedKeys.has(pair.appKey) || processedKeys.has(pair.sheetKey)) {
      continue;
    }

    const defaultResolution = getDefaultResolution("renamed");

    items.push({
      entityType: "inventory",
      key: pair.appKey,
      state: "renamed",
      defaultResolution,
      resolution: defaultResolution,
      appData: buildInventoryAppData(pair.appRow),
      sheetData: buildInventorySheetData(pair.sheetRow),
      renamedFrom: pair.appRow.product_name,
      renamedTo: pair.sheetRow.product_name,
    });

    processedKeys.add(pair.appKey);
    processedKeys.add(pair.sheetKey);
  }

  // Fourth pass: app_only items
  for (const [key, appRow] of appByKey) {
    if (processedKeys.has(key)) continue;

    const defaultResolution = getDefaultResolution("app_only");

    items.push({
      entityType: "inventory",
      key,
      state: "app_only",
      defaultResolution,
      resolution: defaultResolution,
      appData: buildInventoryAppData(appRow),
      sheetData: null,
    });

    processedKeys.add(key);
  }

  // Fifth pass: sheet_only items
  for (const [key, sheetRow] of sheetByKey) {
    if (processedKeys.has(key)) continue;

    const defaultResolution = getDefaultResolution("sheet_only");

    items.push({
      entityType: "inventory",
      key,
      state: "sheet_only",
      defaultResolution,
      resolution: defaultResolution,
      appData: null,
      sheetData: buildInventorySheetData(sheetRow),
    });

    processedKeys.add(key);
  }

  return items;
}

/**
 * Count items by state
 */
export function countByState<T extends { state: SyncState }>(
  items: T[],
): Record<SyncState, number> {
  const counts: Record<SyncState, number> = {
    matched: 0,
    conflict: 0,
    app_only: 0,
    sheet_only: 0,
    renamed: 0,
    moved: 0,
  };

  for (const item of items) {
    counts[item.state]++;
  }

  return counts;
}

// =============================================================================
// Sync Data Converters
// =============================================================================

/**
 * Convert location sync item sheetData to LocationCSVRow format
 */
const locationSheetDataToCSVRow = (
  sheetData: NonNullable<LocationSyncItem["sheetData"]>,
): LocationCSVRow => ({
  location_name: sheetData.locationName,
  parent_name: sheetData.parentName ?? undefined,
  location_type: sheetData.locationType as LocationCSVRow["location_type"],
  description: sheetData.description ?? undefined,
  location_image: sheetData.locationImage ?? undefined,
  last_inventory_date: sheetData.lastInventoryDate ?? undefined,
});

/**
 * Convert location sync item appData to LocationCSVRow format
 */
const locationAppDataToCSVRow = (
  appData: NonNullable<LocationSyncItem["appData"]>,
): LocationCSVRow => ({
  location_name: appData.locationName,
  parent_name: appData.parentName ?? undefined,
  location_type: appData.locationType as LocationCSVRow["location_type"],
  description: appData.description ?? undefined,
  location_image: appData.locationImage ?? undefined,
  last_inventory_date: appData.lastInventoryDate ?? undefined,
});

/**
 * Convert inventory sync item sheetData to InventoryCSVRow format
 */
const inventorySheetDataToCSVRow = (
  sheetData: NonNullable<InventorySyncItem["sheetData"]>,
): InventoryCSVRow => ({
  product_name: sheetData.productName ?? "",
  manufacturer: sheetData.manufacturer ?? undefined,
  category: sheetData.category ?? undefined,
  location_name: sheetData.locationName ?? undefined,
  quantity: sheetData.quantity ?? 1,
  unit: sheetData.unit ?? "each",
  upc: sheetData.upc ?? undefined,
  model: sheetData.model ?? undefined,
  ndb_number: sheetData.ndbNumber ?? undefined,
  expected_qty: sheetData.expectedQty ?? undefined,
  price: sheetData.price ?? undefined,
  unit_mappings: sheetData.unitMappings ?? undefined,
  ingredient_name: sheetData.ingredientName ?? undefined,
  aliases: sheetData.aliases ?? undefined,
  product_image: sheetData.productImage ?? undefined,
});

/**
 * Convert inventory sync item appData to InventoryCSVRow format
 */
const inventoryAppDataToCSVRow = (
  appData: NonNullable<InventorySyncItem["appData"]>,
): InventoryCSVRow => ({
  product_name: appData.productName,
  manufacturer: appData.manufacturer ?? undefined,
  category: appData.category ?? undefined,
  location_name: appData.locationName ?? undefined,
  quantity: appData.quantity ?? 1,
  unit: appData.unit ?? "each",
  upc: appData.upc ?? undefined,
  model: appData.model ?? undefined,
  ndb_number: appData.ndbNumber ?? undefined,
  expected_qty: appData.expectedQty ?? undefined,
  price: appData.price ?? undefined,
  unit_mappings: appData.unitMappings ?? undefined,
  ingredient_name: appData.ingredientName ?? undefined,
  aliases: appData.aliases ?? undefined,
  product_image: appData.productImage ?? undefined,
});

/**
 * Filter sync items with sheetData and convert to CSV rows
 */
export const syncItemsToLocationCSVRows = (
  items: LocationSyncItem[],
  useAppData = false,
): LocationCSVRow[] =>
  items
    .filter((i) => (useAppData ? i.appData : i.sheetData))
    .map((i) =>
      useAppData
        ? locationAppDataToCSVRow(i.appData!)
        : locationSheetDataToCSVRow(i.sheetData!),
    );

/**
 * Filter sync items with data and convert to CSV rows
 * For sheetData, also requires productName to be present
 */
export const syncItemsToInventoryCSVRows = (
  items: InventorySyncItem[],
  useAppData = false,
): InventoryCSVRow[] =>
  items
    .filter((i) => (useAppData ? i.appData : i.sheetData?.productName))
    .map((i) =>
      useAppData
        ? inventoryAppDataToCSVRow(i.appData!)
        : inventorySheetDataToCSVRow(i.sheetData!),
    );
