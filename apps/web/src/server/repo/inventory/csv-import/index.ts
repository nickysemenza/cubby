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

import { dedupe } from "~/misc/array-helpers";
import type { ActorContext } from "~/schemas/context";
import type { LocationId, ProductId } from "~/schemas/identifiers";
import { unsafeLocationId } from "~/schemas/identifiers";
import type {
  CSVImportResult,
  CSVImportResultItem,
  InventoryCSVRow,
} from "~/schemas/inventory";
import type { Database } from "~/server/db";
import { location, product } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  buildInventoryResult,
  createInventoryCounters,
  incrementCounter,
  pushErrorItem,
} from "~/server/repo/csv/result-helpers";
import {
  batchFindIngredients,
  batchFindInventoryEntries,
  batchFindLocations,
  batchFindProductsByNameManufacturer,
  batchInsert,
  batchUpsertInventory,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  generateUniqueLocationShortcode,
  generateUniqueProductShortcode,
} from "~/server/repo/shortcode-utils";
import { processRowInMemory } from "./row-processor-inmemory";

// Re-export utilities that may be used externally
export {
  createOrUpdatePriceMapping,
  createUnitMappingsFromString,
} from "./unit-mapping-handler";

interface ImportOptions {
  dryRun?: boolean;
  actor: ActorContext;
}

/**
 * Import inventory data from CSV rows
 *
 * PERFORMANCE: Uses 3-phase pipeline to eliminate N+1 query pattern
 * - Phase 1: Batch fetch (5-6 queries total)
 * - Phase 2: In-memory processing (0 queries)
 * - Phase 3: Batch write (3-5 queries in transaction)
 *
 * @param db - Database connection
 * @param rows - Parsed CSV rows to import
 * @param options - Import options including userId and source for audit logging
 * @returns Import result with counts and per-row details
 */
export const importInventoryFromCSV = async (
  db: Database,
  rows: InventoryCSVRow[],
  options: ImportOptions,
): Promise<CSVImportResult> => {
  const { dryRun = false, actor } = options;

  if (rows.length === 0) {
    return buildInventoryResult(createInventoryCounters(), []);
  }

  // =========================================================================
  // PHASE 1: Extract keys and batch fetch (5-6 queries total)
  // =========================================================================

  // Extract unique keys from all rows
  const productLookups = rows.map((row) => ({
    name: row.product_name,
    manufacturer: row.manufacturer ?? null,
  }));

  const locationNames = dedupe(
    rows
      .map((r) => r.location_name)
      .filter((n): n is string => Boolean(n?.trim())),
  );

  const locationShortcodes = dedupe(
    rows
      .map((r) => r.location_shortcode)
      .filter((s): s is string => Boolean(s?.trim())),
  );

  const ingredientNames = dedupe(
    rows
      .map((r) => r.ingredient_name)
      .filter((n): n is string => Boolean(n?.trim())),
  );

  // Batch fetch all data in parallel
  const [productMap, locationMap, _ingredientMap] = await Promise.all([
    batchFindProductsByNameManufacturer(db, productLookups),
    batchFindLocations(db, locationNames, locationShortcodes),
    batchFindIngredients(db, ingredientNames),
  ]);

  // Fetch inventory entries for all product+location combinations
  const productIds = Array.from(productMap.values()).map((p) => p.id);
  const locationIds = Array.from(new Set(Array.from(locationMap.values())));

  const _inventoryMap = await batchFindInventoryEntries(
    db,
    productIds,
    locationIds,
  );

  // =========================================================================
  // PHASE 2: Process rows in-memory (0 queries)
  // =========================================================================

  const items: CSVImportResultItem[] = [];
  const counters = createInventoryCounters();

  // Collections for batch writes
  const productsToCreate: Array<{
    name: string;
    manufacturer: string;
    category: string | null;
    upc: string | null;
    model: string | null;
    ndbNumber: number | null;
    expectedQty: number | null;
  }> = [];
  const locationsToCreate: Array<{ name: string }> = [];
  const inventoryToUpsert: Array<{
    productId: ProductId | "PENDING";
    productName: string; // For matching after product creation
    locationId: LocationId | "PENDING_LOCATION";
    locationName?: string; // For matching after location auto-creation
    amount: { value: number; unit: string };
    valuation: number | null;
  }> = [];

  // Process each row in-memory
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const result = processRowInMemory(
        row,
        i,
        {
          productMap,
          locationMap,
          inventoryMap: _inventoryMap,
          ingredientMap: _ingredientMap,
        },
        { dryRun },
      );

      items.push(result.item);
      incrementCounter(counters, result.item.action);

      // Collect write operations (only in non-dry-run mode)
      if (!dryRun) {
        if (result.productToCreate) {
          productsToCreate.push(result.productToCreate);
        }
        if (result.locationToAutoCreate) {
          locationsToCreate.push(result.locationToAutoCreate);
        }
        // Only upsert inventory for actions that modify the database
        // Skip "skipped", "product_only", and "error" actions
        const shouldUpsertInventory =
          result.item.action === "created" ||
          result.item.action === "updated" ||
          result.item.action === "moved";
        if (result.inventoryToUpsert && shouldUpsertInventory) {
          inventoryToUpsert.push(result.inventoryToUpsert);
        }
      }
    } catch (error) {
      console.error("Product import error:", error);
      let message = "Unknown error";
      if (error instanceof Error) {
        message = error.message;
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

  // =========================================================================
  // PHASE 3: Batch write (3-5 queries, within transaction)
  // =========================================================================

  if (
    !dryRun &&
    (productsToCreate.length > 0 ||
      locationsToCreate.length > 0 ||
      inventoryToUpsert.length > 0)
  ) {
    await withTransaction(db, async (tx) => {
      // 1. Batch insert new locations (if auto-created, with generated shortcodes)
      if (locationsToCreate.length > 0) {
        // Deduplicate locations by name (multiple rows may reference same new location)
        const uniqueLocationNames = dedupe(
          locationsToCreate.map((loc) => loc.name),
        );

        // Generate shortcodes for each unique location
        const locationsWithShortcodes = await Promise.all(
          uniqueLocationNames.map(async (name) => ({
            name,
            type: "room" as const,
            parentId: null,
            shortcode: await generateUniqueLocationShortcode(tx),
          })),
        );

        const createdLocations = await batchInsert(
          tx,
          location,
          locationsWithShortcodes,
        );

        // Map created location IDs back to inventory entries
        for (const loc of createdLocations) {
          for (const inv of inventoryToUpsert) {
            if (
              inv.locationId === "PENDING_LOCATION" &&
              inv.locationName === loc.name
            ) {
              inv.locationId = unsafeLocationId(loc.id);
            }
          }
        }
      }

      // 2. Batch insert new products (with generated shortcodes)
      if (productsToCreate.length > 0) {
        // Generate shortcodes for each product
        const productsWithShortcodes = await Promise.all(
          productsToCreate.map(async (p) => ({
            ...p,
            shortcode: await generateUniqueProductShortcode(tx),
          })),
        );

        const createdProducts = await batchInsert(
          tx,
          product,
          productsWithShortcodes,
        );

        // Map created product IDs back to result items and inventory entries
        for (const p of createdProducts) {
          // Update result items
          const item = items.find(
            (i) =>
              i.productName === p.name && i.action !== "error" && !i.productId,
          );
          if (item) item.productId = p.id;

          // Update inventory entries that were waiting for this product ID
          // Match directly by product name stored in the inventory entry
          for (const inv of inventoryToUpsert) {
            if (inv.productId === "PENDING" && inv.productName === p.name) {
              inv.productId = p.id;
            }
          }
        }
      }

      // 3. Batch upsert inventory (only entries with real product IDs and location IDs)
      const validInventory = inventoryToUpsert.filter(
        (inv) =>
          inv.productId !== "PENDING" && inv.locationId !== "PENDING_LOCATION",
      );
      if (validInventory.length > 0) {
        // Strip productName and locationName fields before upserting (only needed for matching)
        const inventoryForDb = validInventory.map(
          ({ productName, locationName, ...rest }) => rest,
        );
        await batchUpsertInventory(tx, inventoryForDb);
      }
    });

    // 4. Log audit entries (outside transaction, async)
    for (const item of items) {
      if (item.action !== "error" && item.productId) {
        const shouldLogProduct =
          item.action === "created" ||
          item.action === "product_only" ||
          item.action === "updated";
        const shouldLogInventory =
          item.action === "created" ||
          item.action === "moved" ||
          item.action === "updated";

        if (shouldLogProduct && item.productWillBeCreated) {
          await logAuditEntry(db, actor, {
            entityType: "product",
            entityId: item.productId,
            action: "create",
          });
        }

        if (shouldLogInventory) {
          const inventoryAction =
            item.action === "created" ? "create" : "update";
          await logAuditEntry(db, actor, {
            entityType: "inventory",
            entityId: item.productId,
            action: inventoryAction,
          });
        }
      }
    }
  }

  return buildInventoryResult(counters, items);
};
