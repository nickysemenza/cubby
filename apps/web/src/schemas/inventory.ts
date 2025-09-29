import { z } from "zod";
import { amount } from "~/codec/codec";
import { dbTimestampsOut } from "./common";
import { inventoryId, productId, locationId } from "./identifiers";

export const inventoryEntryOut = z
  .object({
    id: inventoryId,
    // inventory entries do not have a name, just ID
    amount: amount,
  })
  .extend(dbTimestampsOut.shape);

export const inventoryUpdatePayloadData = z.object({
  amount: amount.optional(),
  productId: productId.optional(),
  locationId: locationId.optional(),
});

// Input schema for updating inventory entries
export const inventoryUpdateInput = z.object({
  id: inventoryId,
  data: inventoryUpdatePayloadData,
});

export type InventoryUpdateInput = z.infer<typeof inventoryUpdateInput>;

export const inventoryCreatePayloadData = z.object({
  productId: productId,
  locationId: locationId,
  amount: amount,
});

// Schema for bulk inventory operations
const inventoryBulkOperationItem = z.object({
  id: z.string().optional(),
  productId: productId,
  locationId: locationId,
  amount: amount,
});

export type InventoryBulkOperationItem = z.infer<
  typeof inventoryBulkOperationItem
>;

export const inventoryBulkOperationPayload = z.object({
  // All operations for a given location
  locationId: locationId,
  items: z.array(inventoryBulkOperationItem),
});
