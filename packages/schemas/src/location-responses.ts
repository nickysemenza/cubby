import { z } from "zod";
import { locationId, locationShortcode } from "./identifiers";
import { inventoryWithProductOut } from "./inventory-responses";
import { locationOut, locationType } from "./location";

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
