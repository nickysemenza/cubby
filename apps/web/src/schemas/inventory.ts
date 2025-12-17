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
  model: z.string().optional(), // product model number
  ndb_number: z.coerce.number().optional(), // USDA NDB number for nutrition data linking
  location_path: z.string().optional(), // "Room > Shelf > Bin" format, or "Room[type] > Shelf[type]" with types. Empty = product-only row
  quantity: z.coerce.number().positive().default(1),
  unit: z.string().default("each"),
  expected_qty: z.coerce.number().int().positive().nullable().optional(), // product's expectedQuantity
  price: z.coerce.number().positive().nullable().optional(), // creates unit mapping "1 each → $X"
  unit_mappings: z.string().nullable().optional(), // "1 stick = 113.4g; 1 cup = 240ml" (non-price mappings)
  ingredient_name: z.string().nullable().optional(), // linked ingredient name (explicit name)
  ingredient: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .optional(), // true = create ingredient with same name as product
  aliases: z.string().nullable().optional(), // semicolon-separated: "sugar;granulated sugar"
});

export type InventoryCSVRow = z.infer<typeof inventoryCSVRow>;

export const inventoryCSVImportPayload = z.object({
  rows: z.array(inventoryCSVRow),
});

export type InventoryCSVImportPayload = z.infer<
  typeof inventoryCSVImportPayload
>;

// Unit mapping detail for preview display
export const unitMappingDetail = z.object({
  from: z.string(), // e.g., "1 stick"
  to: z.string(), // e.g., "113.4g"
});

export type UnitMappingDetail = z.infer<typeof unitMappingDetail>;

// Product metadata changes for preview
export const productChangesPreview = z.object({
  priceWillBeSet: z.number().optional(),
  expectedQuantityWillBeSet: z.number().optional(),
  unitMappingsWillBeAdded: z.number().optional(), // count of new mappings
  unitMappingsDetail: z.array(unitMappingDetail).optional(), // detailed mappings for display
  ingredientWillBeLinked: z.string().optional(), // ingredient name
  modelWillBeSet: z.string().optional(), // model number
  ndbNumberWillBeSet: z.number().optional(), // USDA NDB number
  aliasesWillBeAdded: z.array(z.string()).optional(), // list of aliases to add
});

export type ProductChangesPreview = z.infer<typeof productChangesPreview>;

// Result types for CSV import (and push preview)
export const csvImportResultItem = z.object({
  rowIndex: z.number(),
  action: z.enum([
    "created",
    "moved",
    "updated",
    "skipped",
    "error",
    "product_only",
    "removed", // For push preview: row exists in sheet but not in app
  ]),
  productName: z.string(),
  productId: z.string().optional(), // Product ID for image import
  upc: z.string().optional(), // UPC code for image import
  locationPath: z.string().optional(), // Optional for product-only rows
  message: z.string().optional(),
  // Preview fields
  productWillBeCreated: z.boolean().optional(),
  locationWillBeCreated: z.boolean().optional(),
  movedFrom: z.array(z.string()).optional(), // Location names where item currently is
  productChanges: productChangesPreview.optional(),
});

export type CSVImportResultItem = z.infer<typeof csvImportResultItem>;

export const csvImportResult = z.object({
  created: z.number(),
  moved: z.number(),
  updated: z.number(),
  skipped: z.number(),
  errors: z.number(),
  productOnly: z.number(), // Products created/updated without inventory placement
  removed: z.number().optional(), // For push preview: rows that will be removed from sheet
  items: z.array(csvImportResultItem),
});

export type CSVImportResult = z.infer<typeof csvImportResult>;
