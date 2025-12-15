/**
 * CSV Import for Inventory
 *
 * This module handles importing inventory data from CSV files with smart logic for:
 * - Preview mode (dry-run) showing what changes will occur
 * - Product creation and updates
 * - Location path resolution with type inference
 * - Smart move logic for unique items (expectedQuantity=1)
 * - Skip detection for duplicate entries
 *
 * @example
 * ```ts
 * // Preview what would happen
 * const preview = await importInventoryFromCSV(db, orgId, rows, true);
 *
 * // Actually import
 * const result = await importInventoryFromCSV(db, orgId, rows, false);
 * ```
 */

import { type Database } from "~/server/db";
import { type OrganizationId } from "~/schemas/identifiers";
import {
  type InventoryCSVRow,
  type CSVImportResultItem,
  type CSVImportResult,
} from "~/schemas/inventory";
import { buildLocationTypeContext } from "~/server/repo/location";
import { processRow } from "./row-processor";

// Re-export utilities that may be used externally
export { createOrUpdatePriceMapping } from "./unit-mapping-handler";

/**
 * Import inventory data from CSV rows
 *
 * @param db - Database connection
 * @param organizationId - Organization to import into
 * @param rows - Parsed CSV rows to import
 * @param dryRun - If true, only preview changes without writing to database
 * @returns Import result with counts and per-row details
 */
export const importInventoryFromCSV = async (
  db: Database,
  organizationId: OrganizationId,
  rows: InventoryCSVRow[],
  dryRun: boolean = false,
): Promise<CSVImportResult> => {
  const results: CSVImportResultItem[] = [];
  let created = 0;
  let moved = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let productOnly = 0;

  // Build location type context for inference across the batch
  const locationTypeContext = await buildLocationTypeContext(
    db,
    organizationId,
    rows,
  );

  // Check for conflicting type specifications
  if (locationTypeContext.conflicts.length > 0) {
    for (const conflict of locationTypeContext.conflicts) {
      results.push({
        rowIndex: -1,
        action: "error",
        productName: "",
        message: `Location type conflict for "${conflict.path}": specified as both ${conflict.types.join(" and ")}`,
      });
      errors++;
    }
    return {
      created,
      moved,
      updated,
      skipped,
      errors,
      productOnly,
      items: results,
    };
  }

  // Process each row
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const result = await processRow(
        { db, organizationId, locationTypeContext, dryRun },
        row,
        i,
      );

      results.push(result);

      // Update counters
      switch (result.action) {
        case "created":
          created++;
          break;
        case "moved":
          moved++;
          break;
        case "updated":
          updated++;
          break;
        case "skipped":
          skipped++;
          break;
        case "product_only":
          productOnly++;
          break;
        case "error":
          errors++;
          break;
      }
    } catch (error) {
      results.push({
        rowIndex: i,
        action: "error",
        productName: row.product_name,
        locationPath: row.location_path,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      errors++;
    }
  }

  return {
    created,
    moved,
    updated,
    skipped,
    errors,
    productOnly,
    items: results,
  };
};
