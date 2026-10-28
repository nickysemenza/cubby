import { inventoryPlacementValues } from "@cubby/shared";
import { inventoryShortcode, locationShortcode } from "./identifier-fields";
import { amount } from "./codec";
import { z } from "zod";
import { readSchemas as definitionSchemas } from "./entity-definitions/05-inventory.entity";
import { rawInventoryDetailProduct } from "./inventory-fields";
import { externalIdOut } from "./external-id";
import { unitMappingOut } from "./unitmapping";

/** Repository/compiler projections; public Inventory reads use generated envelopes. */
export const rawInventoryOutput = definitionSchemas.output;
export const rawInventoryList = definitionSchemas.list;
export const rawInventoryDetail = definitionSchemas.detail;
export const rawInventoryMcpDetail = rawInventoryDetail.extend({
  product: rawInventoryDetailProduct.extend({
    externalIds: z.array(externalIdOut.omit({ id: true })),
    unitMappings: z.array(unitMappingOut.omit({ id: true })),
  }),
});
export type RawInventoryDetail = z.output<typeof rawInventoryDetail>;
export const rawReceivingInventoryStock = z.object({
  id: inventoryShortcode,
  locationId: locationShortcode,
  locationName: z.string(),
  amount,
});
export type RawReceivingInventoryStock = z.output<
  typeof rawReceivingInventoryStock
>;

/** Selected grouped-search placement inputs, before canonical field serialization. */
export const rawSearchInventoryPlacement = z.object({
  id: inventoryShortcode,
  locationId: locationShortcode,
  locationPath: z.string(),
  amount,
  placement: z.enum(inventoryPlacementValues),
});
