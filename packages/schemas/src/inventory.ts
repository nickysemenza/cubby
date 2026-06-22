import { z } from "zod";
import { amount } from "./codec";
import { dbTimestampsOut } from "./common";
import { inventoryId, locationId, productId } from "./identifiers";

// Filters accepted by the inventory list endpoint.
export const inventoryFiltersSchema = z.object({
  productNameFilter: z.string().optional(),
  locationNameFilter: z.string().optional(),
  locationIdFilter: locationId.optional(),
});

export const inventoryEntryOut = z
  .object({
    id: inventoryId,
    // inventory entries do not have a name, just ID
    amount: amount,
    valuation: z.number().nullable(), // Precomputed: amount.value * product.price
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
  id: inventoryId.optional(),
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

// Schema for bulk move operations (moving items between locations)
const bulkMoveItem = z.object({
  inventoryEntryId: inventoryId,
  quantity: amount, // How much to move (can be less than total for partial moves)
});

export type BulkMoveItem = z.infer<typeof bulkMoveItem>;

export const bulkMovePayload = z.object({
  sourceLocationId: locationId,
  targetLocationId: locationId,
  items: z.array(bulkMoveItem).min(1),
});

export type BulkMovePayload = z.infer<typeof bulkMovePayload>;
