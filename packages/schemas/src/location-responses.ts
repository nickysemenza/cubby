import { z } from "zod";
import { imageOut } from "./image";
import { inventoryWithProductOut } from "./inventory-responses";
import { locationOut } from "./location";

export const locationOutWithParentChildrenAndInventoryOut = locationOut.extend({
  children: z.array(locationOut),
  parent: locationOut.nullable(),
  inventoryEntries: z.array(inventoryWithProductOut),
  images: z.array(imageOut),
});

export type LocationOutWithParentChildren = z.infer<
  typeof locationOutWithParentChildrenAndInventoryOut
>;
