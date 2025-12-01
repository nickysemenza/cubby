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

// Schema for bulk move operations (moving items between locations)
export const bulkMoveItem = z.object({
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

// CSV Import/Export schemas
export const inventoryCSVRow = z.object({
  product_name: z.string().min(1),
  manufacturer: z.string().optional(), // defaults to "(unspecified)"
  upc: z.string().optional(),
  location_path: z.string().min(1), // "Room > Shelf > Bin" format
  quantity: z.coerce.number().positive().default(1),
  unit: z.string().default("each"),
  expected_qty: z.coerce.number().int().positive().nullable().optional(), // product's expectedQuantity
  price: z.coerce.number().positive().nullable().optional(), // creates unit mapping "1 each → $X"
  unit_mappings: z.string().nullable().optional(), // "1 stick = 113.4g; 1 cup = 240ml" (non-price mappings)
  ingredient_name: z.string().nullable().optional(), // linked ingredient name
});

export type InventoryCSVRow = z.infer<typeof inventoryCSVRow>;

export const inventoryCSVImportPayload = z.object({
  rows: z.array(inventoryCSVRow),
});

export type InventoryCSVImportPayload = z.infer<
  typeof inventoryCSVImportPayload
>;

// Result types for CSV import
export const csvImportResultItem = z.object({
  rowIndex: z.number(),
  action: z.enum(["created", "moved", "skipped", "error"]),
  productName: z.string(),
  locationPath: z.string(),
  message: z.string().optional(),
});

export type CSVImportResultItem = z.infer<typeof csvImportResultItem>;

export const csvImportResult = z.object({
  created: z.number(),
  moved: z.number(),
  skipped: z.number(),
  errors: z.number(),
  items: z.array(csvImportResultItem),
});

export type CSVImportResult = z.infer<typeof csvImportResult>;
