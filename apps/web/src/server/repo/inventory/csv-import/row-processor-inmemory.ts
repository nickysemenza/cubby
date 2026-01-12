/**
 * In-memory row processor for batch CSV import.
 *
 * This is a synchronous version that uses pre-fetched lookup maps
 * instead of making database queries for each row.
 */

import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import type { LocationId, ProductId } from "~/schemas/identifiers";
import type { CSVImportResultItem, InventoryCSVRow } from "~/schemas/inventory";
import type {
  InventoryLookupMap,
  LocationLookupMap,
  ProductLookupMap,
} from "~/server/repo/database-helpers";
import { createProductKey } from "~/server/repo/database-helpers";

interface LookupMaps {
  productMap: ProductLookupMap;
  locationMap: LocationLookupMap;
  inventoryMap: InventoryLookupMap;
  ingredientMap: Map<string, string>;
}

interface RowProcessingResult {
  item: CSVImportResultItem;
  productToCreate?: {
    name: string;
    manufacturer: string;
    category: string | null;
    upc: string | null;
    model: string | null;
    ndbNumber: number | null;
    expectedQty: number | null;
  };
  inventoryToUpsert?: {
    productId: ProductId | "PENDING";
    productName: string; // For matching after product creation
    locationId: LocationId | "PENDING_LOCATION";
    locationName?: string; // For matching after location auto-creation
    amount: { value: number; unit: string };
    valuation: number | null;
  };
  locationToAutoCreate?: {
    name: string;
  };
}

/**
 * Process a CSV row in-memory using pre-fetched lookup maps.
 * Returns both the result item (for display) and pending write operations.
 */
export function processRowInMemory(
  row: InventoryCSVRow,
  rowIndex: number,
  lookups: LookupMaps,
  _options: { dryRun: boolean },
): RowProcessingResult {
  const manufacturer = row.manufacturer ?? UNSPECIFIED_MANUFACTURER;
  const isProductOnly = !row.location_name || row.location_name.trim() === "";

  // Step 1: Lookup existing product
  const productKey = createProductKey(row.product_name, manufacturer);
  const existingProduct = lookups.productMap.get(productKey);

  // Step 2: Determine if product needs to be created/updated
  const productWillBeCreated = !existingProduct;
  const productChanges = {}; // Simplified for now

  // Step 3: Handle product-only rows (no inventory placement)
  if (isProductOnly) {
    return {
      item: {
        action: "product_only",
        rowIndex,
        productName: row.product_name,
        locationName: null,
        productId: existingProduct?.id,
        upc: row.upc ?? null,
        productWillBeCreated,
        productChanges,
      },
      productToCreate: productWillBeCreated
        ? {
            name: row.product_name,
            manufacturer,
            category: row.category ?? null,
            upc: row.upc ?? null,
            model: row.model ?? null,
            ndbNumber: row.ndb_number ?? null,
            expectedQty: row.expected_qty ?? null,
          }
        : undefined,
    };
  }

  // Step 4: Resolve target location
  const locationId = resolveLocationId(row, lookups.locationMap);
  const locationNotFound = !locationId;

  // Step 5: Check inventory state
  const inventoryKey =
    existingProduct && locationId
      ? `${existingProduct.id}|${locationId}`
      : null;
  const existingInventory = inventoryKey
    ? lookups.inventoryMap.get(inventoryKey)
    : null;

  const newAmount = { value: row.quantity, unit: row.unit };

  // Step 6: Determine action
  let action: CSVImportResultItem["action"] = "created";
  let shouldWriteInventory = true;

  if (existingProduct && locationId) {
    if (existingInventory) {
      // Already exists at this location
      const amountsMatch =
        existingInventory.amount.value === newAmount.value &&
        existingInventory.amount.unit === newAmount.unit;

      if (amountsMatch) {
        action = "skipped";
        shouldWriteInventory = false;
      } else {
        action = "updated";
      }
    } else {
      // Check if it's a move (product exists elsewhere with expectedQty=1)
      const allLocations = getAllProductLocations(
        existingProduct.id,
        lookups.inventoryMap,
      );
      const isOnlyAtOneLocation = allLocations.length === 1;

      if (
        isOnlyAtOneLocation &&
        existingProduct.expectedQty === 1 &&
        allLocations[0] !== locationId
      ) {
        action = "moved";
      }
    }
  }

  // Step 7: Build result
  return {
    item: {
      action,
      rowIndex,
      productName: row.product_name,
      locationName: row.location_name,
      productId: existingProduct?.id,
      locationId,
      upc: row.upc ?? null,
      productWillBeCreated,
      productChanges,
      locationNotFound,
    },
    productToCreate: productWillBeCreated
      ? {
          name: row.product_name,
          manufacturer,
          category: row.category ?? null,
          upc: row.upc ?? null,
          model: row.model ?? null,
          ndbNumber: row.ndb_number ?? null,
          expectedQty: row.expected_qty ?? null,
        }
      : undefined,
    inventoryToUpsert:
      shouldWriteInventory && (locationId || row.location_name)
        ? {
            productId: existingProduct?.id ?? "PENDING",
            productName: row.product_name,
            locationId: locationId ?? "PENDING_LOCATION",
            locationName: locationId ? undefined : row.location_name,
            amount: newAmount,
            valuation: row.price ?? null,
          }
        : undefined,
    locationToAutoCreate: locationNotFound
      ? { name: row.location_name! }
      : undefined,
  };
}

/**
 * Resolve location ID from pre-fetched map.
 * Tries shortcode first (more specific), then falls back to name.
 */
function resolveLocationId(
  row: InventoryCSVRow,
  locationMap: LocationLookupMap,
): LocationId | undefined {
  // Try shortcode first (more specific)
  if (row.location_shortcode) {
    const byShortcode = locationMap.get(
      `shortcode:${row.location_shortcode.toUpperCase().trim()}`,
    );
    if (byShortcode) return byShortcode;
  }

  // Fall back to name
  if (row.location_name) {
    const byName = locationMap.get(row.location_name.toLowerCase().trim());
    if (byName) return byName;
  }

  return undefined;
}

/**
 * Get all locations where a product currently exists.
 * Used for move logic detection.
 */
function getAllProductLocations(
  productId: ProductId,
  inventoryMap: InventoryLookupMap,
): LocationId[] {
  const locations: LocationId[] = [];

  for (const [key, entry] of inventoryMap.entries()) {
    if (key.startsWith(`${productId}|`)) {
      locations.push(entry.locationId);
    }
  }

  return locations;
}
