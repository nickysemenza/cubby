import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { timestampedFields } from "./base-entity";
import { mutationSideEffectsSchema } from "./background-jobs";
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
export const inventoryFilterFields = {
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
};

export const inventoryFiltersSchema = z.object(inventoryFilterFields);

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
  verifiedAt: z
    .date()
    .nullable()
    .describe("When last verified in an audit session (null = never)"),
  ...timestampedFields,
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
  ...timestampedFields,
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

const inventoryWithLocationAndProductFields = {
  ...inventoryEntryFields,
  product: inventoryDetailProductOut,
  location: locationOut,
};

export const inventoryWithLocationAndProductOut = z.object(
  inventoryWithLocationAndProductFields,
);
export type InventoryWithLocationAndProductOut = z.infer<
  typeof inventoryWithLocationAndProductOut
>;

export const inventoryWithLocationAndProductAndSideEffectsOut = z.object({
  ...inventoryWithLocationAndProductFields,
  sideEffects: mutationSideEffectsSchema,
});

export const inventoryWithLocationAndProductListOut = z.array(
  inventoryWithLocationAndProductOut,
);

export const inventoryWithLocationAndProductListAndSideEffectsOut = z.object({
  items: inventoryWithLocationAndProductListOut,
  sideEffects: mutationSideEffectsSchema,
});

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
  // When the snapshot was loaded — lets the server reject a stale commit that
  // would delete-on-omit entries another surface added since. Optional so other
  // callers (MCP, tests) are unaffected.
  loadedAt: z.date().optional(),
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

// One staged decision about an expected row, committed atomically on "Done".
// `verify` = confirmed present as-is; `adjust` = present at a corrected count;
// `remove` = not here, soft-delete it; `relocate` = move the full row to the
// selected location (merging with an existing same-product row when needed).
export const inventorySessionResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("verify"), inventoryEntryId: inventoryId }),
  z.object({
    kind: z.literal("adjust"),
    inventoryEntryId: inventoryId,
    // positiveAmount (not amount): a recount to zero is a Remove, not an
    // adjust — this keeps the value > 0 invariant every other write enforces.
    amount: positiveAmount,
  }),
  z.object({ kind: z.literal("remove"), inventoryEntryId: inventoryId }),
  z.object({
    kind: z.literal("relocate"),
    inventoryEntryId: inventoryId,
    targetLocationId: locationId,
  }),
]);

export type InventorySessionResolution = z.infer<
  typeof inventorySessionResolution
>;

// Commit a location's recount as one atomic diff and stamp `lastBulkInventory`.
// The expected-id set and row snapshot timestamp are a compare-and-swap guard: a bin
// that changed after the client loaded must be refreshed, never silently marked
// complete from a stale partial snapshot.
export const reconcileSessionPayload = z.object({
  locationId: locationId,
  expectedInventoryEntryIds: z.array(inventoryId),
  snapshotUpdatedAt: z.date().nullable(),
  resolutions: z.array(inventorySessionResolution),
});

export type ReconcileSessionPayload = z.infer<typeof reconcileSessionPayload>;

export const inventoryFindDuplicatesInput = z.object({
  excludeLocationId: locationId.optional(),
});

export const inventoryLocationIdsInput = z.object({
  locationIds: z.array(locationId),
});

const inventoryMcpProductFields = {
  id: productId,
  name: z.string(),
  manufacturer: z.string(),
  shortcode: productShortcode,
};

const inventoryMcpLocationFields = {
  id: locationId,
  name: z.string(),
};

/** Slim MCP projection of an inventory list/detail row. */
export const inventoryMcpOut = z.object({
  id: inventoryId,
  amount,
  valuation: z.number().nullable(),
  product: z.object(inventoryMcpProductFields).nullable(),
  location: z.object(inventoryMcpLocationFields).nullable(),
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
