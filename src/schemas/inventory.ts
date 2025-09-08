import { z } from "zod";
import { amount } from "~/codec/codec";
import { dbTimestampsOut } from "./common";

export const inventoryEntryOut = z
  .object({
    id: z.uuid(),
    // inventory entries do not have a name, just ID
    amount: amount,
  })
  .extend(dbTimestampsOut.shape);

export const inventoryUpdatePayloadData = z.object({
  amount: amount.optional(),
  productId: z.uuid().optional(),
  locationId: z.uuid().optional(),
});

// Input schema for updating inventory entries
export const inventoryUpdateInput = z.object({
  id: z.uuid(),
  data: inventoryUpdatePayloadData,
});

export type InventoryUpdateInput = z.infer<typeof inventoryUpdateInput>;

export const inventoryCreatePayloadData = z.object({
  productId: z.uuid(),
  locationId: z.uuid(),
  amount: amount,
});

// Schema for bulk inventory operations
export const inventoryBulkOperationItem = z.object({
  id: z.string().optional(),
  productId: z.uuid(),
  locationId: z.uuid(),
  amount: amount,
});
export type InventoryBulkOperationItem = z.infer<
  typeof inventoryBulkOperationItem
>;
export const inventoryBulkOperationPayload = z.object({
  // All operations for a given location
  locationId: z.uuid(),
  items: z.array(inventoryBulkOperationItem),
});
