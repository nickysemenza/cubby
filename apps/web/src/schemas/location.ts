import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { type locationOutWithParentChildrenAndInventoryOut } from "./combo";
import { createInputImages, imageOut, updateInputImages } from "./image";
import { inventoryId, locationId, productId } from "./identifiers";

export const locationType = z
  //todo: remove this in the future to make it more flexible?
  .enum([
    "room",
    "bag",
    "box",
    "shelf",
    "crate",
    "half-crate",
    "milk-crate",
    "tote-bin",
    "table",
    "drawer",
    "cart",
    "cabinet",
  ])
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;

/** Pre-built options for location type select fields */
export const locationTypeOptions = locationType.options.map((type) => ({
  value: type,
  label: type,
}));
export const locationBase = z.object({
  name: z.string().describe("name of location"),
  type: locationType,
});
export const locationOut = z
  .object({
    id: locationId,
    lastBulkInventory: z.date().nullable(),
    images: z.array(imageOut),
  })
  .extend(locationBase.shape)
  .extend(dbTimestampsOut.shape);

export type LocationOut = z.infer<typeof locationOut>;

/** Minimal inventory item info for tree display */
export const inventoryItemForTree = z.object({
  id: inventoryId,
  amount: z.object({
    value: z.number(),
    unit: z.string(),
  }),
  productName: z.string(),
  productId: productId,
});
export type InventoryItemForTree = z.infer<typeof inventoryItemForTree>;

export type InfLocation = LocationOut & {
  children?: InfLocation[];
  parent?: InfLocation;
  /** Number of inventory items directly at this location */
  directItemCount?: number;
  /** Number of inventory items at this location and all descendants */
  totalItemCount?: number;
  /** Inventory items at this location (for expanded tree view) */
  inventoryItems?: InventoryItemForTree[];
};

export const infLocation: z.ZodType<InfLocation> = locationOut.extend({
  children: z.lazy(() => infLocation.array()).optional(),
  parent: z.lazy(() => infLocation.optional()),
  directItemCount: z.number().optional(),
  totalItemCount: z.number().optional(),
  inventoryItems: z.array(inventoryItemForTree).optional(),
});

export type LocationOutWithParentChildren = z.infer<
  typeof locationOutWithParentChildrenAndInventoryOut
>;

// Input schema for creating locations
export const locationCreateInput = locationBase
  .extend({
    parentId: locationId.nullable(),
  })
  .merge(createInputImages);

// Input schema for updating locations
export const locationUpdateInput = z.object({
  id: locationId,
  data: locationCreateInput.partial().extend(updateInputImages.shape),
});

export type LocationCreateInput = z.infer<typeof locationCreateInput>;
export type LocationUpdateInput = z.infer<typeof locationUpdateInput>;

// ============================================================================
// Location CSV Import/Export Schemas
// ============================================================================

import { fieldChange } from "./csv";

/**
 * CSV row schema for location import/export
 * Uses location_name (unique) and parent_name instead of hierarchical paths
 */
export const locationCSVRow = z.object({
  location_name: z.string().min(1), // Required: unique location name
  parent_name: z.string().nullable().optional(), // Parent location name (null for root)
  location_type: locationType.optional(), // Optional: defaults to "room" for root, "shelf" for children
  description: z.string().nullable().optional(),
  location_image: z.string().optional(), // Semicolon-separated image URLs
  last_inventory_date: z.string().nullable().optional(), // ISO timestamp of when location was last inventoried
});

export type LocationCSVRow = z.infer<typeof locationCSVRow>;

/**
 * Individual result item for location CSV import
 */
export const locationCSVImportResultItem = z.object({
  rowIndex: z.number(),
  action: z.enum(["created", "updated", "skipped", "error", "removed"]),
  locationName: z.string(),
  locationId: locationId.optional(),
  message: z.string().optional(),
  fieldChanges: z.array(fieldChange).optional(),
  // Preview fields
  locationWillBeCreated: z.boolean().optional(),
  imageWillBeImported: z.string().optional(),
  imageImportSkipped: z.boolean().optional(),
  imageImportError: z.string().optional(),
});

export type LocationCSVImportResultItem = z.infer<
  typeof locationCSVImportResultItem
>;

/**
 * Result of location CSV import operation
 */
export const locationCSVImportResult = z.object({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  errors: z.number(),
  removed: z.number().optional(), // For push preview: locations that will be removed from sheet
  items: z.array(locationCSVImportResultItem),
});

export type LocationCSVImportResult = z.infer<typeof locationCSVImportResult>;
