import { z } from "zod";
import { amount } from "./codec";
import {
  inventoryId,
  locationId,
  locationShortcode,
  productId,
} from "./identifiers";
import { imageOut } from "./image-responses";
import { inventoryWithProductOut } from "./inventory-responses";
import {
  type LocationOut,
  locationOut,
  locationType,
  locationValuation,
} from "./location";

const locationResponseFields = {
  id: locationId,
  shortcode: locationShortcode,
  name: z.string().describe("name of location"),
  type: locationType,
  lastBulkInventory: z.date().nullable(),
  aiDescription: z.string().nullable(),
  images: z.array(imageOut),
  // Persisted valuation rollup; null until first recompute.
  valuation: locationValuation.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const locationListRefOut = z.object({
  id: locationId,
  shortcode: locationShortcode,
  name: z.string(),
  type: locationType,
});
export type LocationListRefOut = z.infer<typeof locationListRefOut>;

export const locationListItemOut = z.object({
  ...locationResponseFields,
  children: z.array(locationListRefOut),
  parent: locationListRefOut.nullable(),
  inventoryEntries: z.array(inventoryWithProductOut),
});
export type LocationListItemOut = z.infer<typeof locationListItemOut>;

export const locationWithParentNameOut = z.object({
  ...locationResponseFields,
  parentName: z.string().nullable(),
});
export type LocationWithParentNameOut = z.infer<
  typeof locationWithParentNameOut
>;

export const locationTypeCountsOut = z.record(locationType, z.number());

export const touchLastBulkInventoryOut = z.object({
  success: z.boolean(),
});

export const locationsWithParentNameOut = z.array(locationWithParentNameOut);

export const recentlyActiveLocationsOut = z.array(locationOut);

export const recomputeLocationValuationsOut = z.object({
  updated: z.number(),
});

export const locationChildCountsOut = z.record(z.string(), z.number());

/** Minimal inventory item info for tree display */
const inventoryItemForTree = z.object({
  id: inventoryId,
  amount,
  productName: z.string(),
  productId,
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

export const infLocation: z.ZodType<InfLocation> = z.object({
  ...locationResponseFields,
  children: z.lazy(() => infLocation.array()).optional(),
  parent: z.lazy(() => infLocation.optional()),
  childCount: z.number().optional(),
  directItemCount: z.number().optional(),
  totalItemCount: z.number().optional(),
  inventoryItems: z.array(inventoryItemForTree).optional(),
});

export const infLocationListOut = z.array(infLocation);
