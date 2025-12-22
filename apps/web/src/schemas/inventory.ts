import { z } from "zod";
import { upc, ndb } from "@recipehub/usda-schemas";
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
  upc: upc.optional(),
  model: z.string().optional(), // product model number
  ndb_number: z.coerce.number().pipe(ndb).optional(), // USDA NDB number (1000-99999)
  location_name: z.string().optional(), // Location name (must exist). Empty = product-only row
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
  product_image: z.string().url().nullable().optional(), // URL of product's primary image
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
// Each field has optional "current" value for showing from→to changes
export const productChangesPreview = z.object({
  // Manufacturer update (from "(unspecified)" to specific)
  manufacturerWillBeSet: z.string().optional(),
  manufacturerCurrent: z.string().nullable().optional(),
  // Price: "1 each → $X" mapping
  priceWillBeSet: z.number().optional(),
  priceCurrent: z.number().nullable().optional(),
  // Expected quantity
  expectedQuantityWillBeSet: z.number().optional(),
  expectedQuantityCurrent: z.number().nullable().optional(),
  // Unit mappings
  unitMappingsWillBeAdded: z.number().optional(), // count of new mappings
  unitMappingsDetail: z.array(unitMappingDetail).optional(), // detailed mappings for display
  unitMappingsCurrent: z.string().nullable().optional(), // current mappings as string
  // Ingredient linking
  ingredientWillBeLinked: z.string().optional(), // ingredient name
  ingredientCurrent: z.string().nullable().optional(),
  // Model number
  modelWillBeSet: z.string().optional(),
  modelCurrent: z.string().nullable().optional(),
  // UPC code
  upcWillBeSet: upc.optional(),
  upcCurrent: z.string().nullable().optional(), // lenient - may contain legacy invalid data
  // USDA NDB number
  ndbNumberWillBeSet: ndb.optional(),
  ndbNumberCurrent: z.number().nullable().optional(), // lenient - may contain legacy invalid data
  // Aliases
  aliasesWillBeAdded: z.array(z.string()).optional(), // list of aliases to add
  aliasesCurrent: z.array(z.string()).optional(),
  // Image import preview
  imageWillBeImported: z.string().optional(), // URL of image to import
  imageImportSkipped: z.boolean().optional(), // true if product already has images
  imageImportError: z.string().optional(), // error message if import failed
});

export type ProductChangesPreview = z.infer<typeof productChangesPreview>;

// Field change for displaying diffs
// Re-exported from shared csv types for backward compatibility
import { fieldChange } from "./csv";
export { fieldChange, type FieldChange } from "./csv";

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
    "removed", // For pull: exists in app but not in sheet; for push: exists in sheet but not in app
    "renamed", // Product renamed (detected by UPC match, name containment, or location match)
  ]),
  productName: z.string(),
  productId: z.string().optional(), // Product ID for image import
  inventoryEntryId: inventoryId.optional(), // Inventory entry ID for deletion during pull
  upc: z.string().optional(), // UPC code for image import
  locationName: z.string().optional(), // Optional for product-only rows
  locationId: locationId.optional(), // Location ID for linking to location page
  message: z.string().optional(),
  fieldChanges: z.array(fieldChange).optional(), // Structured field changes for display
  // Preview fields
  productWillBeCreated: z.boolean().optional(),
  locationNotFound: z.boolean().optional(), // True if location name doesn't exist
  movedFrom: z.array(z.string()).optional(), // Location names where item currently is
  productChanges: productChangesPreview.optional(),
  // Rename tracking
  renamedFrom: z.string().optional(), // Previous product name for renamed action
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
  renamed: z.number().optional(), // For push preview: products that were renamed
  items: z.array(csvImportResultItem),
});

export type CSVImportResult = z.infer<typeof csvImportResult>;
