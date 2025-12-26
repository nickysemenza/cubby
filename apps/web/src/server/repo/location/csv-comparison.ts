/**
 * Location CSV comparison utilities for push/pull preview
 *
 * Compares app locations with sheet locations to generate a diff preview
 * showing what changes would be made when pushing to or pulling from Google Sheets.
 */

import {
  type LocationCSVRow,
  type LocationCSVImportResult,
  type LocationCSVImportResultItem,
} from "~/schemas/location";
import { type FieldChange, LOCATION_CSV_ACTIONS } from "~/schemas/csv";
import { type LocationCSVExportRow } from "./types";
import {
  createComparisonFunction,
  normalizeForComparison,
} from "~/server/repo/csv";
import { type LocationId } from "~/schemas/identifiers";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

/**
 * Normalize date strings for comparison.
 * Handles both app format (YYYY-MM-DD HH:mm:ss) and Sheets format (MM/DD/YYYY HH:mm:ss)
 */
const normalizeDateForComparison = (
  dateStr: string | null | undefined,
): number | null => {
  if (!dateStr) return null;
  // Try parsing with common formats
  const formats = [
    "YYYY-MM-DD HH:mm:ss", // App format
    "M/D/YYYY H:mm:ss", // Sheets format (single digits)
    "MM/DD/YYYY HH:mm:ss", // Sheets format (padded)
  ];
  for (const fmt of formats) {
    const parsed = dayjs(dateStr, fmt, true);
    if (parsed.isValid()) {
      return parsed.unix();
    }
  }
  // Fallback: try native parsing
  const fallback = dayjs(dateStr);
  return fallback.isValid() ? fallback.unix() : null;
};

/**
 * Compare two location rows and return structured field changes
 */
export function getLocationRowDifferences(
  appRow: LocationCSVExportRow,
  sheetRow: LocationCSVRow,
): FieldChange[] {
  const changes: FieldChange[] = [];

  // Compare parent_name
  const appParent = appRow.parent_name?.toLowerCase().trim() ?? null;
  const sheetParent = sheetRow.parent_name?.toLowerCase().trim() ?? null;
  if (appParent !== sheetParent) {
    changes.push({
      field: "parent_name",
      from: sheetRow.parent_name ?? null,
      to: appRow.parent_name,
    });
  }

  // Compare location_type
  if (
    sheetRow.location_type &&
    appRow.location_type !== sheetRow.location_type
  ) {
    changes.push({
      field: "location_type",
      from: sheetRow.location_type,
      to: appRow.location_type,
    });
  }

  // Compare description
  if (sheetRow.description !== undefined) {
    const appDesc = appRow.description ?? "";
    const sheetDesc = sheetRow.description ?? "";
    if (appDesc !== sheetDesc) {
      changes.push({
        field: "description",
        from: sheetRow.description ?? null,
        to: appRow.description ?? null,
      });
    }
  }

  // Compare location_image
  if ((appRow.location_image ?? "") !== (sheetRow.location_image ?? "")) {
    changes.push({
      field: "location_image",
      from: sheetRow.location_image ?? null,
      to: appRow.location_image ?? null,
    });
  }

  // Compare last_inventory_date (normalize to handle different date formats)
  const appDate = normalizeDateForComparison(appRow.last_inventory_date);
  const sheetDate = normalizeDateForComparison(sheetRow.last_inventory_date);
  if (appDate !== sheetDate) {
    changes.push({
      field: "last_inventory_date",
      from: sheetRow.last_inventory_date ?? null,
      to: appRow.last_inventory_date ?? null,
    });
  }

  return changes;
}

/**
 * Internal comparison function using shared framework
 */
const compareLocationsInternal = createComparisonFunction<
  LocationCSVExportRow,
  LocationCSVRow,
  LocationCSVImportResultItem,
  (typeof LOCATION_CSV_ACTIONS)[number]
>({
  actions: LOCATION_CSV_ACTIONS,

  getSheetKey: (row) => normalizeForComparison(row.location_name),
  getAppKey: (row) => normalizeForComparison(row.location_name),

  getDifferences: getLocationRowDifferences,

  buildCreatedItem: (rowIndex, appRow) => ({
    rowIndex,
    action: "created",
    locationName: appRow.location_name,
    locationId: appRow.location_id,
    message: "Will be added to sheet",
  }),

  buildUpdatedItem: (rowIndex, appRow, fieldChanges) => ({
    rowIndex,
    action: "updated",
    locationName: appRow.location_name,
    locationId: appRow.location_id,
    fieldChanges,
  }),

  buildSkippedItem: (rowIndex, appRow) => ({
    rowIndex,
    action: "skipped",
    locationName: appRow.location_name,
    locationId: appRow.location_id,
  }),

  buildRemovedItem: (sheetRow) => ({
    rowIndex: -1,
    action: "removed",
    locationName: sheetRow.location_name,
    message: "Will be removed from sheet",
  }),

  createdAction: "created",
  updatedAction: "updated",
  skippedAction: "skipped",
  removedAction: "removed",
});

/**
 * Compare app location rows with sheet rows to generate a diff preview
 *
 * Used by push preview to show what changes would be made to the Locations sheet.
 * Compares by unique location_name.
 */
export function compareLocationsForPush(
  appRows: LocationCSVExportRow[],
  sheetRows: LocationCSVRow[],
): LocationCSVImportResult {
  const result = compareLocationsInternal(appRows, sheetRows);

  // Map to LocationCSVImportResult format
  return {
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.error,
    removed: result.removed > 0 ? result.removed : undefined,
    items: result.items,
  };
}

/**
 * Removed location item with location ID for deletion
 */
export interface RemovedLocationItem extends LocationCSVImportResultItem {
  action: "removed";
  locationIdToDelete: LocationId;
}

/**
 * Find locations that exist in app but not in sheet (deleted from sheet)
 *
 * Used by pull preview to show what would be deleted, and by apply pull
 * to actually delete the locations.
 *
 * Note: Deletion safety (checking for inventory) is handled at apply time,
 * not during this comparison.
 */
export function findRemovedLocationsForPull(
  appRows: LocationCSVExportRow[],
  sheetRows: LocationCSVRow[],
): RemovedLocationItem[] {
  const removedItems: RemovedLocationItem[] = [];

  // Build a set of location names from sheet (normalized for comparison)
  const sheetLocationNames = new Set<string>();
  for (const row of sheetRows) {
    sheetLocationNames.add(normalizeForComparison(row.location_name));
  }

  // Find app locations that don't exist in sheet
  for (const appRow of appRows) {
    const normalizedName = normalizeForComparison(appRow.location_name);
    if (!sheetLocationNames.has(normalizedName)) {
      removedItems.push({
        rowIndex: -1,
        action: "removed",
        locationName: appRow.location_name,
        locationId: appRow.location_id,
        locationIdToDelete: appRow.location_id,
        message: "Location will be deleted (removed from sheet)",
      });
    }
  }

  return removedItems;
}
