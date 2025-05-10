import { z } from "zod";
import { amount } from "~/codec/codec";
import { dbTimestampsOut } from "./util";

export const inventoryEntryOut = z
  .object({
    id: z.string().uuid(),
    // inventory entries do not have a name, just ID
    amount: amount,
  })
  .merge(dbTimestampsOut);

export const inventoryUpdatePayloadData = z.object({
  amount: amount.optional(),
  productId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
});

// Input schema for updating inventory entries
export const inventoryUpdateInput = z.object({
  id: z.string().uuid(),
  data: inventoryUpdatePayloadData,
});

export type InventoryUpdateInput = z.infer<typeof inventoryUpdateInput>;

export const inventoryCreatePayloadData = z.object({
  productId: z.string().uuid(),
  locationId: z.string().uuid(),
  amount: amount,
});

// Schema for bulk inventory operations
export const inventoryBulkOperationItem = z.object({
  id: z.string().optional(),
  productId: z.string().uuid(),
  locationId: z.string().uuid(),
  amount: amount,
});
export type InventoryBulkOperationItem = z.infer<
  typeof inventoryBulkOperationItem
>;
export const inventoryBulkOperationPayload = z.object({
  // All operations for a given location
  locationId: z.string().uuid(),
  items: z.array(inventoryBulkOperationItem),
});
