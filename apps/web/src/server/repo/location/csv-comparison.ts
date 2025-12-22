/**
 * Location CSV comparison utilities for push preview
 *
 * Compares app locations with sheet locations to generate a diff preview
 * showing what changes would be made when pushing to Google Sheets.
 */

import {
  type LocationCSVRow,
  type LocationCSVImportResult,
  type LocationCSVImportResultItem,
  type LocationFieldChange,
} from "~/schemas/location";
import { type LocationCSVExportRow } from "./types";

/**
 * Normalize a location name for comparison (lowercase, trimmed)
 */
function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Compare two location rows and return structured field changes
 */
export function getLocationRowDifferences(
  appRow: LocationCSVExportRow,
  sheetRow: LocationCSVRow,
): LocationFieldChange[] {
  const changes: LocationFieldChange[] = [];

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

  return changes;
}

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
  const items: LocationCSVImportResultItem[] = [];
  const counters = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    removed: 0,
  };

  // Build a map of sheet rows by normalized name
  const sheetByName = new Map<string, LocationCSVRow>();
  for (const row of sheetRows) {
    sheetByName.set(normalizeName(row.location_name), row);
  }

  // Track which sheet names we've matched
  const matchedSheetNames = new Set<string>();

  // Compare app rows against sheet
  for (let i = 0; i < appRows.length; i++) {
    const appRow = appRows[i];
    const normalizedName = normalizeName(appRow.location_name);
    const sheetRow = sheetByName.get(normalizedName);

    if (!sheetRow) {
      // New location - doesn't exist in sheet
      items.push({
        rowIndex: i,
        action: "created",
        locationName: appRow.location_name,
        locationId: appRow.location_id,
        message: "Will be added to sheet",
      });
      counters.created++;
    } else {
      matchedSheetNames.add(normalizedName);

      // Location exists - check if different
      const fieldChanges = getLocationRowDifferences(appRow, sheetRow);

      if (fieldChanges.length > 0) {
        items.push({
          rowIndex: i,
          action: "updated",
          locationName: appRow.location_name,
          locationId: appRow.location_id,
          fieldChanges,
        });
        counters.updated++;
      } else {
        items.push({
          rowIndex: i,
          action: "skipped",
          locationName: appRow.location_name,
          locationId: appRow.location_id,
        });
        counters.skipped++;
      }
    }
  }

  // Find locations in sheet that weren't matched (will be removed)
  for (const sheetRow of sheetRows) {
    const normalizedName = normalizeName(sheetRow.location_name);
    if (!matchedSheetNames.has(normalizedName)) {
      items.push({
        rowIndex: -1,
        action: "removed",
        locationName: sheetRow.location_name,
        message: "Will be removed from sheet",
      });
      counters.removed++;
    }
  }

  return {
    ...counters,
    items,
  };
}
