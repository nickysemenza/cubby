import { z } from "zod";
import { dbTimestampsOut } from "./util";
import { type locationOutWithParentChildrenAndInventoryOut } from "./combo";

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
export type LocationBase = z.infer<typeof locationBase>;
export const locationOut = z
  .object({
    id: z.string().uuid(),
    lastBulkInventory: z.date().nullable(),
  })
  .merge(locationBase)
  .merge(dbTimestampsOut);

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

export const collectInfiniteParents = (location: InfLocation) => {
  const parentHierarchy = [];
  let parent = location.parent;
  while (parent) {
    parentHierarchy.push(parent);
    parent = parent.parent;
  }
  return parentHierarchy;
};
