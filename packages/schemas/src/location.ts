import { locationTypeValues } from "@cubby/shared";
import { z } from "zod";
import { amount } from "./codec";
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
  .enum(locationTypeValues)
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;

// Re-export for consumers that need the values array
export { locationTypeValues } from "@cubby/shared";

// Filters accepted by the location list endpoint.
export const locationFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  itemTypeFilter: locationType.optional(),
});

const locationBase = z.object({
  name: z.string().describe("name of location"),
  type: locationType,
});
export const locationOut = z
  .object({
    id: locationId,
    shortcode: locationShortcode,
    lastBulkInventory: z.date().nullable(),
    aiDescription: z.string().nullable(),
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
