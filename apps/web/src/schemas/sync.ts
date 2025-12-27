/**
 * Omnidirectional sync types and schemas
 *
 * Used for bidirectional sync between app and Google Sheets.
 */

import { z } from "zod";
import { parseCSVDateToUnix } from "~/server/repo/csv/date-utils";
import { fieldChange } from "./csv";
import { inventoryId, locationId, productId } from "./identifiers";
import { productCategory } from "./product";

/**
 * Sync states for items
 */
const syncState = z.enum([
  "matched", // Identical in both app and sheet
  "conflict", // Different in both app and sheet
  "app_only", // Exists in app but not in sheet
  "sheet_only", // Exists in sheet but not in app
  "renamed", // Same item with name changed (detected via heuristics)
  "moved", // Same item with location changed (inventory only)
]);

export type SyncState = z.infer<typeof syncState>;

/**
 * Resolution actions for sync items
 */
const syncResolution = z.enum([
  "use_app", // Use app version (for conflicts)
  "use_sheet", // Use sheet version (for conflicts)
  "add_to_app", // Add to app (for sheet_only, default)
  "add_to_sheet", // Add to sheet (for app_only, default)
  "delete_from_app", // Delete from app (for sheet_only, alternative)
  "delete_from_sheet", // Delete from sheet (for app_only, alternative)
  "apply_rename", // Apply the rename
  "apply_move", // Apply the move
]);

export type SyncResolution = z.infer<typeof syncResolution>;

/**
 * Base sync item - common fields for all sync items (internal, used by locationSyncItem/inventorySyncItem)
 */
const baseSyncItem = z.object({
  state: syncState,
  defaultResolution: syncResolution.nullable(),
  resolution: syncResolution.nullable(), // User's choice, null if not yet resolved
  fieldDiffs: z.array(fieldChange).optional(), // For conflicts, shows what differs
});

/**
 * Location sync item
 */
const locationSyncItem = baseSyncItem.extend({
  entityType: z.literal("location"),
  key: z.string(), // Normalized location name
  appData: z
    .object({
      locationId: locationId,
      locationName: z.string(),
      parentName: z.string().nullable(),
      locationType: z.string(),
      description: z.string().nullable(),
      locationImage: z.string().nullable(),
      lastInventoryDate: z.string().nullable(),
    })
    .nullable(),
  sheetData: z
    .object({
      locationName: z.string(),
      parentName: z.string().nullable().optional(),
      locationType: z.string().optional(),
      description: z.string().nullable().optional(),
      locationImage: z.string().nullable().optional(),
      lastInventoryDate: z.string().nullable().optional(),
    })
    .nullable(),
  // For renames
  renamedFrom: z.string().optional(),
  renamedTo: z.string().optional(),
});

export type LocationSyncItem = z.infer<typeof locationSyncItem>;

/**
 * Common inventory sync fields (shared between app and sheet data)
 */
const inventorySyncFields = z.object({
  productName: z.string(),
  manufacturer: z.string().nullable(),
  category: productCategory.nullable(),
  locationName: z.string().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  upc: z.string().nullable(),
  model: z.string().nullable(),
  ndbNumber: z.number().nullable(),
  expectedQty: z.number().nullable(),
  price: z.number().nullable(),
  unitMappings: z.string().nullable(),
  ingredientName: z.string().nullable(),
  aliases: z.string().nullable(),
  productImage: z.string().nullable(),
});

/**
 * Inventory sync item
 */
const inventorySyncItem = baseSyncItem.extend({
  entityType: z.literal("inventory"),
  key: z.string(), // Normalized product|manufacturer|location
  appData: inventorySyncFields
    .extend({
      // App-specific IDs
      productId: productId,
      locationId: locationId.nullable(),
      inventoryEntryId: inventoryId.nullable(),
    })
    .nullable(),
  sheetData: inventorySyncFields.partial().nullable(),
  // For renames
  renamedFrom: z.string().optional(),
  renamedTo: z.string().optional(),
  // For moves
  movedFrom: z.string().optional(),
  movedTo: z.string().optional(),
});

export type InventorySyncItem = z.infer<typeof inventorySyncItem>;

/**
 * Combined sync preview result
 */
export const syncPreviewResult = z.object({
  locations: z.object({
    items: z.array(locationSyncItem),
    matched: z.number(),
    conflicts: z.number(),
    appOnly: z.number(),
    sheetOnly: z.number(),
    renamed: z.number(),
  }),
  inventory: z.object({
    items: z.array(inventorySyncItem),
    matched: z.number(),
    conflicts: z.number(),
    appOnly: z.number(),
    sheetOnly: z.number(),
    renamed: z.number(),
    moved: z.number(),
  }),
  // Validation errors that block sync
  validationErrors: z.array(
    z.object({
      message: z.string(),
      itemKey: z.string().optional(),
      entityType: z.enum(["location", "inventory"]).optional(),
    }),
  ),
  canApply: z.boolean(), // False if there are unresolved conflicts or validation errors
});

export type SyncPreviewResult = z.infer<typeof syncPreviewResult>;

/**
 * Input for applying sync - includes user resolutions
 */
export const applySyncInput = z.object({
  locationResolutions: z.record(z.string(), syncResolution), // key -> resolution
  inventoryResolutions: z.record(z.string(), syncResolution), // key -> resolution
});

/**
 * Result of applying sync
 */
export const applySyncResult = z.object({
  locations: z.object({
    created: z.number(),
    updated: z.number(),
    deleted: z.number(),
    errors: z.number(),
  }),
  inventory: z.object({
    created: z.number(),
    updated: z.number(),
    deleted: z.number(),
    moved: z.number(),
    errors: z.number(),
  }),
  success: z.boolean(),
  errorMessages: z.array(z.string()),
});

/**
 * Check if a value is empty (null, undefined, or empty string)
 */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Get smart default resolution for conflicts based on field diffs.
 * If all changes are additive (empty → value), default to using the side with values.
 * For last_inventory_date, prefer the newer date when both sides have values.
 * Internal helper - used only by getDefaultResolution.
 */
function getSmartConflictResolution(
  fieldDiffs: Array<{ field: string; from: unknown; to: unknown }>,
): SyncResolution | null {
  if (fieldDiffs.length === 0) return null;

  // Special case: last_inventory_date conflict - prefer newer date
  if (
    fieldDiffs.length === 1 &&
    fieldDiffs[0]!.field === "last_inventory_date"
  ) {
    const { from, to } = fieldDiffs[0]!;
    if (!isEmpty(from) && !isEmpty(to)) {
      const sheetTs = parseCSVDateToUnix(from as string);
      const appTs = parseCSVDateToUnix(to as string);
      if (sheetTs !== null && appTs !== null) {
        return appTs >= sheetTs ? "use_app" : "use_sheet";
      }
    }
  }

  // Check if all diffs are "app adding data" (sheet empty, app has value)
  const allAppAdding = fieldDiffs.every(
    (diff) => isEmpty(diff.from) && !isEmpty(diff.to),
  );
  if (allAppAdding) return "use_app";

  // Check if all diffs are "sheet adding data" (app empty, sheet has value)
  const allSheetAdding = fieldDiffs.every(
    (diff) => !isEmpty(diff.from) && isEmpty(diff.to),
  );
  if (allSheetAdding) return "use_sheet";

  // True conflict - user must choose
  return null;
}

/**
 * Get default resolution for a sync state
 */
export function getDefaultResolution(
  state: SyncState,
  fieldDiffs?: Array<{ field: string; from: unknown; to: unknown }>,
): SyncResolution | null {
  switch (state) {
    case "matched":
      return null; // No action needed
    case "conflict":
      // Try smart resolution based on field diffs
      if (fieldDiffs) {
        return getSmartConflictResolution(fieldDiffs);
      }
      return null; // Must be resolved by user
    case "app_only":
      return "add_to_sheet";
    case "sheet_only":
      return "add_to_app";
    case "renamed":
      return "apply_rename";
    case "moved":
      return "apply_move";
  }
}
