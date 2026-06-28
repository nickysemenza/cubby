import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { amount, positiveAmount } from "./codec";
import { externalIdOut } from "./external-id";
import { imageOut } from "./image";
import {
  inventoryId,
  locationId,
  locationShortcode,
  productId,
  productShortcode,
} from "./identifiers";
import { locationOut, locationType } from "./location";
import { productCategory } from "./product";
import { duplicateUniqueProductSchema } from "./problems";
import {
  createItemsResponseSchema,
  createPaginatedResponseSchema,
} from "./pagination";
import { unitMappingOut } from "./unitmapping";

export { positiveAmount } from "./codec";

// Filters accepted by the inventory list endpoint.
export const inventoryFiltersSchema = z.object({
  productNameFilter: z
    .string()
    .optional()
    .describe("Filter by product name (substring)"),
  locationNameFilter: z
    .string()
    .optional()
    .describe("Filter by location name (substring)"),
  locationIdFilter: locationId
    .optional()
    .describe("Filter by exact location ID"),
});

export const inventorySortableFields = [
  "createdAt",
  "name",
  "product",
  "location",
  "amount",
  "valuation",
] as const;

export type InventorySortField = (typeof inventorySortableFields)[number];

export const inventoryEntryFields = {
  id: inventoryId,
  // inventory entries do not have a name, just ID
  amount: amount.describe("Quantity on hand"),
  valuation: z
    .number()
    .nullable()
    .describe("Precomputed value: amount × product price"),
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const inventoryEntryOut = z.object(inventoryEntryFields);

const productInventoryEmbedFields = {
  id: productId,
  shortcode: productShortcode,
  name: z.string(),
  upc: upc.nullable(),
  fdc_id: fdcId.nullable(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  category: productCategory.nullable(),
  price: z.number().nullable(),
  usdaUnavailable: z.boolean().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const productInventoryEmbedOut = z.object(productInventoryEmbedFields);
export type ProductInventoryEmbedOut = z.infer<typeof productInventoryEmbedOut>;

export const inventoryWithProductOut = z.object({
  ...inventoryEntryFields,
  product: productInventoryEmbedOut,
});

export const inventoryWithLocationOut = z.object({
  ...inventoryEntryFields,
  location: locationOut,
});

export const inventoryListProductOut = z.object({
  id: productId,
  shortcode: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  upc: upc.nullable(),
  fdc_id: fdcId.nullable(),
  category: productCategory.nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  model: z.string().nullable(),
  price: z.number().nullable(),
  usdaUnavailable: z.boolean().nullable(),
});
export type InventoryListProductOut = z.infer<typeof inventoryListProductOut>;

export const inventoryListLocationOut = z.object({
  id: locationId,
  shortcode: locationShortcode,
  name: z.string(),
  type: locationType,
});
export type InventoryListLocationOut = z.infer<typeof inventoryListLocationOut>;

export const inventoryListItemOut = z.object({
  ...inventoryEntryFields,
  product: inventoryListProductOut,
  location: inventoryListLocationOut,
});
export type InventoryListItemOut = z.infer<typeof inventoryListItemOut>;

export const inventoryDetailProductOut = z.object({
  ...productInventoryEmbedFields,
  images: z.array(imageOut),
  externalIds: z.array(externalIdOut),
  unitMappings: z.array(unitMappingOut),
});

export const inventoryWithLocationAndProductOut = z.object({
  ...inventoryEntryFields,
  product: inventoryDetailProductOut,
  location: locationOut,
});
export type InventoryWithLocationAndProductOut = z.infer<
  typeof inventoryWithLocationAndProductOut
>;

export const inventoryWithLocationAndProductListOut = z.array(
  inventoryWithLocationAndProductOut,
);

export const inventoryDuplicateUniqueProductsOut = z.array(
  duplicateUniqueProductSchema,
);

export const inventoryCountsByLocationOut = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

export const inventoryUpdatePayloadData = z.object({
  amount: positiveAmount.optional(),
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
  amount: positiveAmount,
});

// Schema for bulk inventory operations
const inventoryBulkOperationItem = z.object({
  id: inventoryId.optional(),
  productId: productId,
  locationId: locationId,
  amount: positiveAmount,
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
  quantity: positiveAmount, // How much to move (can be less than total for partial moves)
});

export type BulkMoveItem = z.infer<typeof bulkMoveItem>;

export const bulkMovePayload = z.object({
  sourceLocationId: locationId,
  targetLocationId: locationId,
  items: z.array(bulkMoveItem).min(1),
});

export type BulkMovePayload = z.infer<typeof bulkMovePayload>;

export const inventoryFindDuplicatesInput = z.object({
  excludeLocationId: locationId.optional(),
});

export const inventoryLocationIdsInput = z.object({
  locationIds: z.array(locationId),
});

/** Slim MCP projection of an inventory list/detail row. */
export const inventoryMcpOut = inventoryListItemOut
  .pick({ id: true, amount: true, valuation: true })
  .extend({
    product: inventoryListProductOut
      .pick({ id: true, name: true, manufacturer: true, shortcode: true })
      .nullable(),
    location: inventoryListLocationOut
      .pick({ id: true, name: true })
      .nullable(),
  });
export type InventoryMcpOut = z.infer<typeof inventoryMcpOut>;

export const inventoryMcpListOut =
  createPaginatedResponseSchema(inventoryMcpOut);
export const inventoryMcpBulkMoveOut =
  createItemsResponseSchema(inventoryMcpOut);
export const inventoryDuplicateFindOut = createItemsResponseSchema(
  duplicateUniqueProductSchema,
);

export const inventoryCreateInput = inventoryCreatePayloadData;
export const inventoryUpdatePayload = inventoryUpdatePayloadData;
