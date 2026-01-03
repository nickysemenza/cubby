/**
 * Location CSV comparison utilities
 *
 * Compares app locations with sheet locations to detect field changes.
 */

import type { FieldChange } from "~/schemas/csv";
import type { LocationCSVRow } from "~/schemas/location";
import { parseCSVDateToUnix } from "~/server/repo/csv/date-utils";
import {
  type ComparisonFieldSpec,
  compareFields,
} from "~/server/repo/csv/field-utils";
import type { LocationCSVExportRow } from "./types";

/**
 * Normalize date strings for comparison (returns unix timestamp)
 */
const normalizeDateForComparison = (val: unknown): number | null =>
  parseCSVDateToUnix(val as string | null | undefined);

/** Normalize parent name for comparison (lowercase, trimmed) */
const normalizeParentName = (v: unknown): string | null =>
  (v as string)?.toLowerCase().trim() ?? null;

/** Field specs for standard location fields */
const LOCATION_FIELD_SPECS: readonly ComparisonFieldSpec<
  LocationCSVExportRow,
  LocationCSVRow
>[] = [
  // Shortcode - sync from app to sheet (sheet won't have this initially)
  {
    field: "location_shortcode",
    appKey: "location_shortcode",
    sheetKey: "location_shortcode",
  },
  {
    field: "parent_name",
    appKey: "parent_name",
    sheetKey: "parent_name",
    normalize: normalizeParentName,
  },
  {
    field: "location_image",
    appKey: "location_image",
    sheetKey: "location_image",
  },
  {
    field: "last_inventory_date",
    appKey: "last_inventory_date",
    sheetKey: "last_inventory_date",
    normalize: normalizeDateForComparison,
  },
];

/**
 * Compare two location rows and return structured field changes
 */
export function getLocationRowDifferences(
  appRow: LocationCSVExportRow,
  sheetRow: LocationCSVRow,
): FieldChange[] {
  const changes: FieldChange[] = [];

  // Special case: location_type - only compare if sheet has a value
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

  // Special case: description - only compare if sheet has the field defined
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

  // All other fields use generic comparison
  changes.push(...compareFields(LOCATION_FIELD_SPECS, appRow, sheetRow));

  return changes;
}
