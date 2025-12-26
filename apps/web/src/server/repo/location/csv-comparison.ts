/**
 * Location CSV comparison utilities
 *
 * Compares app locations with sheet locations to detect field changes.
 */

import type { LocationCSVRow } from "~/schemas/location";
import type { FieldChange } from "~/schemas/csv";
import type { LocationCSVExportRow } from "./types";
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
