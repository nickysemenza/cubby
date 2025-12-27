/**
 * CSV comparison utilities for inventory sync
 *
 * Compares inventory data between app and sheet representations
 * to detect field-level differences.
 */

import type { InventoryCSVRow } from "~/schemas/inventory";
import type { FieldChange } from "~/schemas/csv";
import type { InventoryCSVExportRow } from "./types";
import { normalizeForComparison } from "~/server/repo/csv/normalize";
import {
  compareFields,
  nullToNull,
  type ComparisonFieldSpec,
} from "~/server/repo/csv/field-utils";

/** Field specs for standard inventory fields (no special normalization needed) */
const INVENTORY_FIELD_SPECS: readonly ComparisonFieldSpec<
  InventoryCSVExportRow,
  InventoryCSVRow
>[] = [
  { field: "manufacturer", appKey: "manufacturer", sheetKey: "manufacturer" },
  { field: "upc", appKey: "upc", sheetKey: "upc" },
  { field: "model", appKey: "model", sheetKey: "model" },
  { field: "category", appKey: "category", sheetKey: "category" },
  {
    field: "ndb",
    appKey: "ndb_number",
    sheetKey: "ndb_number",
    normalize: nullToNull,
  },
  {
    field: "expected",
    appKey: "expected_qty",
    sheetKey: "expected_qty",
    normalize: nullToNull,
  },
  { field: "price", appKey: "price", sheetKey: "price", normalize: nullToNull },
  {
    field: "unit_mappings",
    appKey: "unit_mappings",
    sheetKey: "unit_mappings",
  },
  {
    field: "ingredient",
    appKey: "ingredient_name",
    sheetKey: "ingredient_name",
  },
  { field: "aliases", appKey: "aliases", sheetKey: "aliases" },
  {
    field: "product_image",
    appKey: "product_image",
    sheetKey: "product_image",
  },
];

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

  // Special case: location_name needs normalized comparison (lowercase, trimmed)
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

  // Special case: quantity/unit have defaults (1/each) for product-only rows
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

  // All other fields use generic comparison
  changes.push(...compareFields(INVENTORY_FIELD_SPECS, appRow, sheetRow));

  return changes;
}
