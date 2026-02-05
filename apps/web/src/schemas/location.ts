import { z } from "zod";
import type { locationOutWithParentChildrenAndInventoryOut } from "./combo";
import { dbTimestampsOut } from "./common";
import {
  inventoryId,
  locationId,
  locationShortcode,
  productId,
} from "./identifiers";
import { createInputImages, imageOut, updateInputImages } from "./image";

export const locationType = z
  //todo: remove this in the future to make it more flexible?
  .enum([
    "room",
    "area",
    "bag",
    "box",
    "shelf",
    "crate",
    "half-crate",
    "quarter-crate",
    "milk-crate",
    "tote-bin",
    "table",
    "drawer",
    "cart",
    "cabinet",
  ])
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;

const locationBase = z.object({
  name: z.string().describe("name of location"),
  type: locationType,
});
export const locationOut = z
  .object({
    id: locationId,
    shortcode: locationShortcode,
    lastBulkInventory: z.date().nullable(),
    images: z.array(imageOut),
  })
  .extend(locationBase.shape)
  .extend(dbTimestampsOut.shape);

export type LocationOut = z.infer<typeof locationOut>;

/** Minimal inventory item info for tree display */
const inventoryItemForTree = z.object({
  id: inventoryId,
  amount,
  productName: z.string(),
  productId: productId,
});
export type InventoryItemForTree = z.infer<typeof inventoryItemForTree>;

export type InfLocation = LocationOut & {
  children?: InfLocation[];
  parent?: InfLocation;
  /** Number of direct child locations */
  childCount?: number;
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
  childCount: z.number().optional(),
  directItemCount: z.number().optional(),
  totalItemCount: z.number().optional(),
  inventoryItems: z.array(inventoryItemForTree).optional(),
});

export type LocationOutWithParentChildren = z.infer<
  typeof locationOutWithParentChildrenAndInventoryOut
>;

// Helper to coerce empty strings to null for optional ID fields
const optionalLocationId = z
  .string()
  .nullable()
  .transform((val) => (val === "" ? null : val))
  .pipe(locationId.nullable());

// Input schema for creating locations
export const locationCreateInput = locationBase
  .extend({
    parentId: optionalLocationId,
  })
  .merge(createInputImages);

// Input schema for updating locations
export const locationUpdateInput = z.object({
  id: locationId,
  data: locationCreateInput.partial().extend(updateInputImages.shape),
});

export type LocationCreateInput = z.infer<typeof locationCreateInput>;
export type LocationUpdateInput = z.infer<typeof locationUpdateInput>;

import { amount } from "~/codec/codec";
import { baseCsvImportCounts, baseCsvResultItem } from "./csv";

/**
 * CSV row schema for location import/export
 * Uses location_name (unique) and parent_name instead of hierarchical paths
 */
export const locationCSVRow = z.object({
  location_name: z.string().min(1), // Required: unique location name
  location_shortcode: z.string().nullable().optional(), // L-XXXX format (for matching)
  parent_name: z.string().nullable().optional(), // Parent location name (null for root)
  location_type: locationType.optional(), // Optional: defaults to "room" for root, "shelf" for children
  description: z.string().nullable().optional(),
  location_image: z.string().optional(), // Semicolon-separated image URLs
  last_inventory_date: z.string().nullable().optional(), // ISO timestamp of when location was last inventoried
  // Timestamps (optional, only present when SYNC_TIMESTAMPS enabled)
  location_created_at: z.string().nullable().optional(),
  location_updated_at: z.string().nullable().optional(),
});

export type LocationCSVRow = z.infer<typeof locationCSVRow>;

/**
 * Individual result item for location CSV import
 */
const locationCSVImportResultItem = baseCsvResultItem.extend({
  action: z.enum(["created", "updated", "skipped", "error", "removed"]),
  locationName: z.string(),
  locationId: locationId.optional(),
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
export const locationCSVImportResult = baseCsvImportCounts.extend({
  items: z.array(locationCSVImportResultItem),
});

export type LocationCSVImportResult = z.infer<typeof locationCSVImportResult>;
