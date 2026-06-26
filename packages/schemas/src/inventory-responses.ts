import { z } from "zod";
import { inventoryEntryOut } from "./inventory";
import { locationOut } from "./location";
import { productTopLevelOut } from "./product";
import { unitMappingOut } from "./unitmapping";

export const productInventoryEmbedOut = productTopLevelOut.omit({
  images: true,
  externalIds: true,
});

export const inventoryWithProductOut = inventoryEntryOut.extend({
  product: productInventoryEmbedOut,
});

export const inventoryWithLocationOut = inventoryEntryOut.extend({
  location: locationOut,
});

export const inventoryListProductOut = productTopLevelOut.pick({
  id: true,
  shortcode: true,
  name: true,
  manufacturer: true,
  upc: true,
  fdc_id: true,
  category: true,
  expectedQuantity: true,
  model: true,
  price: true,
  usdaUnavailable: true,
});

export const inventoryListLocationOut = locationOut.pick({
  id: true,
  shortcode: true,
  name: true,
  type: true,
});

export const inventoryListItemOut = inventoryEntryOut.extend({
  product: inventoryListProductOut,
  location: inventoryListLocationOut,
});
export type InventoryListItemOut = z.infer<typeof inventoryListItemOut>;

export const inventoryWithLocationAndProductOut = inventoryEntryOut.extend({
  product: productTopLevelOut.extend({
    unitMappings: z.array(unitMappingOut),
  }),
  location: locationOut,
});
export type InventoryWithLocationAndProductOut = z.infer<
  typeof inventoryWithLocationAndProductOut
>;
