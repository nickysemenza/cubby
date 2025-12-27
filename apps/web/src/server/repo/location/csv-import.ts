/**
 * Location CSV import
 */

import type { Database } from "~/server/db";
import type { OrganizationId, LocationId } from "~/schemas/identifiers";
import type {
  LocationCSVRow,
  LocationCSVImportResult,
  LocationCSVImportResultItem,
  LocationType,
} from "~/schemas/location";
import {
  findLocationByName,
  findOrCreateLocationByName,
  updateLocationFromImport,
} from "~/server/repo/location";
import {
  importLocationImages,
  previewLocationImages,
  locationHasImages,
} from "~/server/repo/inventory/csv-import/image-handler";
import {
  createLocationCounters,
  incrementCounter,
} from "~/server/repo/csv/result-helpers";
import { parseCSVDate } from "~/server/repo/csv/date-utils";

interface ImportOptions {
  dryRun: boolean;
}

/**
 * Determine default location type based on whether it has a parent
 */
function getDefaultLocationType(hasParent: boolean): LocationType {
  return hasParent ? "shelf" : "room";
}

/**
 * Process a single location CSV row
 */
async function processLocationRow(
  db: Database,
  organizationId: OrganizationId,
  row: LocationCSVRow,
  rowIndex: number,
  options: ImportOptions,
): Promise<LocationCSVImportResultItem> {
  const { dryRun } = options;

  try {
    // Check if location already exists
    const existingLocationId = await findLocationByName(
      db,
      organizationId,
      row.location_name,
    );

    // Resolve parent if specified
    let parentId: LocationId | null = null;
    if (row.parent_name) {
      parentId = await findLocationByName(db, organizationId, row.parent_name);
      if (!parentId && !dryRun) {
        return {
          rowIndex,
          action: "error",
          locationName: row.location_name,
          message: `Parent location "${row.parent_name}" not found`,
        };
      }
    }

    if (dryRun) {
      // Preview mode
      if (existingLocationId) {
        // Check if images would be imported
        if (row.location_image) {
          const imagePreview = await previewLocationImages(
            db,
            existingLocationId,
            row.location_image,
          );

          if (imagePreview.locationImageWillBeImported) {
            return {
              rowIndex,
              action: "updated",
              locationName: row.location_name,
              locationId: existingLocationId,
              imageWillBeImported: imagePreview.locationImageWillBeImported,
            };
          }

          if (imagePreview.locationImageImportSkipped) {
            return {
              rowIndex,
              action: "skipped",
              locationName: row.location_name,
              locationId: existingLocationId,
              imageImportSkipped: true,
              message: "Location exists, already has images",
            };
          }
        }

        // Location exists, no image changes
        return {
          rowIndex,
          action: "skipped",
          locationName: row.location_name,
          locationId: existingLocationId,
          message: "Location already exists",
        };
      }

      // Check if parent would exist (either already exists or will be created by earlier row)
      if (row.parent_name && !parentId) {
        return {
          rowIndex,
          action: "error",
          locationName: row.location_name,
          message: `Parent location "${row.parent_name}" not found`,
        };
      }

      // Location will be created
      const imageWillBeImported = row.location_image || undefined;
      return {
        rowIndex,
        action: "created",
        locationName: row.location_name,
        locationWillBeCreated: true,
        imageWillBeImported,
      };
    }

    // Execution mode
    const locationType =
      row.location_type ?? getDefaultLocationType(parentId !== null);

    const { locationId, created } = await findOrCreateLocationByName(
      db,
      organizationId,
      row.location_name,
      parentId,
      locationType,
    );

    // If location exists, update fields from CSV (description, last_inventory_date)
    let updated = false;
    if (!created) {
      updated = await updateLocationFromImport(db, locationId, {
        description: row.description,
        lastInventoryDate: parseCSVDate(row.last_inventory_date),
      });
    }

    // Import images if provided and location doesn't already have any
    let imageImportError: string | undefined;
    if (row.location_image) {
      const hasImages = await locationHasImages(db, locationId);
      if (!hasImages) {
        const imageResult = await importLocationImages(
          db,
          organizationId,
          locationId,
          row.location_image,
          row.location_name,
        );
        if (!imageResult.success && imageResult.error) {
          imageImportError = imageResult.error;
        }
      }
    }

    const message = imageImportError
      ? `(image import failed: ${imageImportError})`
      : undefined;

    // Determine action: created > updated > skipped
    let action: "created" | "updated" | "skipped";
    if (created) {
      action = "created";
    } else if (updated) {
      action = "updated";
    } else {
      action = "skipped";
    }

    return {
      rowIndex,
      action,
      locationName: row.location_name,
      locationId,
      message:
        action === "skipped" ? (message ?? "Location already exists") : message,
    };
  } catch (error) {
    return {
      rowIndex,
      action: "error",
      locationName: row.location_name,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Sort rows so parents come before children
 * Rows with no parent come first, then rows whose parent appears earlier
 */
function sortRowsParentsFirst(rows: LocationCSVRow[]): LocationCSVRow[] {
  const sorted: LocationCSVRow[] = [];
  const remaining = [...rows];
  const processedNames = new Set<string>();

  // First pass: add all rows without parents
  for (let i = remaining.length - 1; i >= 0; i--) {
    if (!remaining[i].parent_name) {
      sorted.push(remaining[i]);
      processedNames.add(remaining[i].location_name.toLowerCase());
      remaining.splice(i, 1);
    }
  }

  // Subsequent passes: add rows whose parent has been processed
  let madeProgress = true;
  while (remaining.length > 0 && madeProgress) {
    madeProgress = false;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const row = remaining[i];
      if (
        row.parent_name &&
        processedNames.has(row.parent_name.toLowerCase())
      ) {
        sorted.push(row);
        processedNames.add(row.location_name.toLowerCase());
        remaining.splice(i, 1);
        madeProgress = true;
      }
    }
  }

  // Add any remaining rows (their parents may be in DB already)
  sorted.push(...remaining);

  return sorted;
}

/**
 * Import locations from CSV rows
 *
 * Handles both preview (dry-run) and actual execution modes.
 * Creates locations with parents first to ensure hierarchy is valid.
 */
export const importLocationsFromCSV = async (
  db: Database,
  organizationId: OrganizationId,
  rows: LocationCSVRow[],
  options: ImportOptions,
): Promise<LocationCSVImportResult> => {
  const counters = createLocationCounters();
  const items: LocationCSVImportResultItem[] = [];

  // Sort rows so parents are processed before children
  const sortedRows = sortRowsParentsFirst(rows);

  for (let i = 0; i < sortedRows.length; i++) {
    const row = sortedRows[i];
    // Find the original index in the unsorted array
    const originalIndex = rows.findIndex(
      (r) => r.location_name.toLowerCase() === row.location_name.toLowerCase(),
    );

    const result = await processLocationRow(
      db,
      organizationId,
      row,
      originalIndex,
      options,
    );

    items.push(result);
    incrementCounter(counters, result.action);
  }

  // Re-sort items by original row index for display
  items.sort((a, b) => a.rowIndex - b.rowIndex);

  return {
    created: counters.created,
    updated: counters.updated,
    skipped: counters.skipped,
    errors: counters.error,
    items,
  };
};
