import { z } from "zod";
import { amount } from "./codec";
import {
  inventoryId,
  locationId,
  locationShortcode,
  productId,
} from "./identifiers";
import { inventoryWithProductOut } from "./inventory-responses";
import { type LocationOut, locationOut, locationType } from "./location";

export const locationListRefOut = z.object({
  id: locationId,
  shortcode: locationShortcode,
  name: z.string(),
  type: locationType,
});
export type LocationListRefOut = z.infer<typeof locationListRefOut>;

export const locationListItemOut = locationOut.extend({
  children: z.array(locationListRefOut),
  parent: locationListRefOut.nullable(),
  inventoryEntries: z.array(inventoryWithProductOut),
});
export type LocationListItemOut = z.infer<typeof locationListItemOut>;

export const locationWithParentNameOut = locationOut.extend({
  parentName: z.string().nullable(),
});
export type LocationWithParentNameOut = z.infer<
  typeof locationWithParentNameOut
>;

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

export const infLocation: z.ZodType<InfLocation> = locationOut.extend({
  children: z.lazy(() => infLocation.array()).optional(),
  parent: z.lazy(() => infLocation.optional()),
  childCount: z.number().optional(),
  directItemCount: z.number().optional(),
  totalItemCount: z.number().optional(),
  inventoryItems: z.array(inventoryItemForTree).optional(),
});
