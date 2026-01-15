/**
 * Snapshot hash generation for sync race condition prevention.
 * Generates stable hashes from raw CSV data to detect concurrent changes.
 */

import crypto from "node:crypto";

import type { InventoryCSVRow } from "~/schemas/inventory";
import type { LocationCSVRow } from "~/schemas/location";

/**
 * Generate stable hash from sync data snapshot.
 * Uses raw CSV rows (before comparison) to detect any data changes.
 *
 * The hash is computed from sorted arrays to ensure stability regardless
 * of the order in which data is fetched.
 */
export function generateSnapshotHash(
  appLocations: LocationCSVRow[],
  sheetLocations: LocationCSVRow[],
  appInventory: InventoryCSVRow[],
  sheetInventory: InventoryCSVRow[],
): string {
  // Sort all arrays for stable ordering
  // Locations sorted by name
  const sortedAppLocations = [...appLocations].sort((a, b) =>
    a.location_name.localeCompare(b.location_name),
  );
  const sortedSheetLocations = [...sheetLocations].sort((a, b) =>
    a.location_name.localeCompare(b.location_name),
  );

  // Inventory sorted by composite key: product name | manufacturer | location name
  const inventorySortFn = (a: InventoryCSVRow, b: InventoryCSVRow) => {
    const keyA = `${a.product_name}|${a.manufacturer ?? ""}|${a.location_name ?? ""}`;
    const keyB = `${b.product_name}|${b.manufacturer ?? ""}|${b.location_name ?? ""}`;
    return keyA.localeCompare(keyB);
  };
  const sortedAppInventory = [...appInventory].sort(inventorySortFn);
  const sortedSheetInventory = [...sheetInventory].sort(inventorySortFn);

  // Create deterministic snapshot object
  const snapshot = {
    appLocations: sortedAppLocations,
    sheetLocations: sortedSheetLocations,
    appInventory: sortedAppInventory,
    sheetInventory: sortedSheetInventory,
  };

  // Generate SHA-256 hash
  const json = JSON.stringify(snapshot);
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Check if a snapshot is stale (too old to trust).
 * Snapshots older than the specified age should be rejected to prevent
 * applying resolutions to very old data.
 *
 * Default max age is 5 minutes - balances between user decision time and
 * reducing the race condition window.
 */
export function isSnapshotStale(
  snapshotTimestamp: number,
  maxAgeMs = 5 * 60 * 1000, // 5 minutes
): boolean {
  const now = Date.now();
  return now - snapshotTimestamp > maxAgeMs;
}
