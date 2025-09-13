import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { type locationOutWithParentChildrenAndInventoryOut } from "./combo";
import { createInputImages, imageOut, updateInputImages } from "./image";

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
    id: z.uuid(),
    lastBulkInventory: z.date().nullable(),
    images: z.array(imageOut),
  })
  .extend(locationBase.shape)
  .extend(dbTimestampsOut.shape);

export type LocationOut = z.infer<typeof locationOut>;

export type InfLocation = LocationOut & {
  children?: InfLocation[];
  parent?: InfLocation;
};

export const infLocation: z.ZodType<InfLocation> = locationOut.extend({
  children: z.lazy(() => infLocation.array()).optional(),
  parent: z.lazy(() => infLocation.optional()),
});

export type LocationOutWithParentChildren = z.infer<
  typeof locationOutWithParentChildrenAndInventoryOut
>;

// Input schema for creating locations
export const locationCreateInput = locationBase
  .extend({
    parentId: z.uuid().nullable(),
  })
  .merge(createInputImages);

// Input schema for updating locations
export const locationUpdateInput = z.object({
  id: z.uuid(),
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
