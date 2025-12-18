import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { type locationOutWithParentChildrenAndInventoryOut } from "./combo";
import { createInputImages, imageOut, updateInputImages } from "./image";
import { locationId } from "./identifiers";

export const locationType = z
  //todo: remove this in the future to make it more flexible?
  .enum([
    "room",
    "bag",
    "shelf",
    "crate",
    "half-crate",
    "table",
    "drawer",
    "cart",
    "cabinet",
  ])
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;
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
  id: z.string(),
  amount: z.object({
    value: z.number(),
    unit: z.string(),
  }),
  productName: z.string(),
  productId: z.string(),
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

export const collectInfiniteParents = (location: InfLocation) => {
  const parentHierarchy = [];
  let parent = location.parent;
  while (parent) {
    parentHierarchy.push(parent);
    parent = parent.parent;
  }
  return parentHierarchy;
};
