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
 * const preview = await importInventoryFromCSV(db, orgId, rows, { dryRun: true, userId: "user123" });
 *
 * // Actually import
 * const result = await importInventoryFromCSV(db, orgId, rows, { userId: "user123", source: "csv_import" });
 * ```
 */

import { type Database } from "~/server/db";
import { type OrganizationId } from "~/schemas/identifiers";
import {
  type InventoryCSVRow,
  type CSVImportResultItem,
  type CSVImportResult,
} from "~/schemas/inventory";
import { processRow } from "./row-processor";
import { logAuditEntry } from "~/server/repo/audit-log";
import { type ActorContext } from "~/schemas/context";
import {
  createResultCounters,
  incrementLegacyCounter,
  buildImportResult,
  pushErrorItem,
} from "~/server/repo/csv/result-helpers";

// Re-export utilities that may be used externally
export { createOrUpdatePriceMapping } from "./unit-mapping-handler";

interface ImportOptions {
  dryRun?: boolean;
  actor: ActorContext;
}

/**
 * Import inventory data from CSV rows
 *
 * @param db - Database connection
 * @param organizationId - Organization to import into
 * @param rows - Parsed CSV rows to import
 * @param options - Import options including userId and source for audit logging
 * @returns Import result with counts and per-row details
 */
export const importInventoryFromCSV = async (
  db: Database,
  organizationId: OrganizationId,
  rows: InventoryCSVRow[],
  options: ImportOptions,
): Promise<CSVImportResult> => {
  const { dryRun = false, actor } = options;
  const items: CSVImportResultItem[] = [];
  const counters = createResultCounters();

  // Process each row
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const result = await processRow(
        { db, organizationId, dryRun, actor },
        row,
        i,
      );

      items.push(result);
      incrementLegacyCounter(counters, result.action);

      // Log audit entries for actual changes (not dry run)
      if (!dryRun && result.productId) {
        const shouldLogProduct =
          result.action === "created" ||
          result.action === "product_only" ||
          result.action === "updated";
        const shouldLogInventory =
          result.action === "created" ||
          result.action === "moved" ||
          result.action === "updated";

        // Log product audit entry
        if (shouldLogProduct && result.productWillBeCreated) {
          await logAuditEntry(db, actor, {
            entityType: "product",
            entityId: result.productId,
            action: "create",
          });
        }

        // Log inventory audit entry
        if (shouldLogInventory) {
          const inventoryAction =
            result.action === "created" ? "create" : "update";
          await logAuditEntry(db, actor, {
            entityType: "inventory",
            entityId: result.productId, // Using productId as reference for now
            action: inventoryAction,
          });
        }
      }
    } catch (error) {
      // Extract meaningful error message from database errors
      let message = "Unknown error";
      if (error instanceof Error) {
        // Check for PostgreSQL constraint violation details
        const pgError = error as Error & {
          code?: string;
          constraint?: string;
          detail?: string;
        };
        if (pgError.constraint) {
          // Parse constraint name to human-readable message
          // Include the detail which often has the conflicting value
          const detail = pgError.detail ? ` (${pgError.detail})` : "";
          if (pgError.constraint.includes("upc")) {
            message = `UPC '${row.upc}' already exists on another product${detail}`;
          } else if (pgError.constraint.includes("ndb_number")) {
            message = `NDB number '${row.ndb_number}' already exists on another product${detail}`;
          } else if (pgError.constraint.includes("name_manufacturer")) {
            message = `Product '${row.product_name}' by '${row.manufacturer}' already exists`;
          } else {
            message = `Constraint violation: ${pgError.constraint}${detail}`;
          }
        } else {
          message = error.message;
        }
      }
      pushErrorItem(
        items,
        counters,
        i,
        row.product_name,
        message,
        row.location_name,
      );
    }
  }

  return buildImportResult(counters, items);
};
