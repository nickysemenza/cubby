import { inventoryPlacementValues } from "@cubby/shared";
import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { inventoryRelatedFilterFields } from "./related-view";
import { auditDateFilterFields, timestampedFields } from "./base-entity";
import { mutationSideEffectsSchema } from "./background-jobs";
import { amount, positiveAmount } from "./codec";
import { externalIdOut } from "./external-id";
import { imageOut } from "./image";
import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { locationOut, locationType } from "./location";
import { productCategory } from "./product";
import { plainDate } from "./project";
import { duplicateUniqueProductSchema } from "./problems";
import {
  createItemsResponseSchema,
  createPaginatedResponseSchema,
  entityFilter,
  oneOrMany,
} from "./pagination";
import { unitMappingOut } from "./unitmapping";

export { positiveAmount } from "./codec";

/**
 * Whether an entry is movable stock or a fixed installation.
 *
 * `installed` is a record you want to keep and never want to see: the dimmer
 * wired into the kitchen wall, the recessed cans in the ceiling, the faucet on
 * the sink. It is excluded from browsing, counting, auditing and staleness —
 * you cannot walk over and recount a fixture — but INCLUDED everywhere the
 * question is ownership, provenance, pricing, identity, move or merge, because
 * you still own the faucet and its purchase Expense is still in the ledger.
 *
 * The grain is deliberate. A `durable|consumable` flag on Product could never
 * work, because "these units got installed" is a fact about a particular
 * placement, not about a product type — the same 150-pack of wire nuts is
 * stock in the garage and consumed in the wall.
 */
export { inventoryPlacementValues } from "@cubby/shared";
export type { InventoryPlacement } from "@cubby/shared";
export const inventoryPlacement = z.enum(inventoryPlacementValues);

/**
 * Tri-state, and explicitly NOT `inventoryPlacement.optional()`.
 *
 * "Empty filter field means unrestricted" is the repo-wide rule, so an omitted
 * two-value filter would hand the UI the stock set while MCP `list_inventory`
 * and any direct tRPC caller got the unfiltered one — the two disagreeing
 * silently is the exact class of bug this whole change exists to remove. The
 * default lives server-side in `inventoryentryList`.
 */
export const inventoryPlacementFilter = z.enum([
  ...inventoryPlacementValues,
  "all",
]);

// Filters accepted by the inventory list endpoint.
export const inventoryFilterFields = {
  ...auditDateFilterFields,
  ...inventoryRelatedFilterFields,
  productNameFilter: z
    .string()
    .optional()
    .describe("Filter by product name (substring)"),
  locationNameFilter: z
    .string()
    .optional()
    .describe("Filter by location name (substring)"),
  locationIdFilter: entityFilter(locationShortcode)
    .optional()
    .describe("Filter by exact location ID"),
  productIdFilter: entityFilter(productShortcode)
    .optional()
    .describe("Filter by exact product ID"),
  manufacturerFilter: z
    .string()
    .optional()
    .describe("Filter by product manufacturer (substring)"),
  categoryFilter: oneOrMany(productCategory)
    .optional()
    .describe("Filter by product category"),
  placementFilter: inventoryPlacementFilter
    .optional()
    .describe(
      "Filter by placement. Omitted defaults to 'stock' (movable stock only); 'installed' returns fixtures; 'all' returns both.",
    ),
  locationRole: z
    .enum(["global_unknown"])
    .optional()
    .describe("Filter by a stable household location role."),
  verifiedPresenceFilter: z.enum(["has", "none"]).optional(),
  /**
   * Derived valuation integrity. `missing_with_priced_product` is the precise
   * "the Product has a price, but this stored unit cannot reach it" state.
   */
  valuationStatus: z
    .enum(["valued", "missing", "missing_with_priced_product"])
    .optional(),
  verifiedFrom: plainDate.optional(),
  verifiedTo: plainDate.optional(),
};

export const inventoryFiltersSchema = z.object(inventoryFilterFields);

export const inventorySortableFields = [
  "createdAt",
  "updatedAt",
  "name",
  "product",
  "location",
  "amount",
  "valuation",
  // Last deliberate recount (null = never). Sortable so "what haven't I counted
  // in ages?" is one click — NULLS LAST in both directions per the house rule.
  "verifiedAt",
] as const;

export type InventorySortField = (typeof inventorySortableFields)[number];

export const inventoryEntryFields = {
  id: inventoryShortcode,
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
  placement: inventoryPlacement.describe(
    "'stock' = movable stock; 'installed' = a fixed installation, kept as a record but excluded from browsing, counting and audits",
  ),
  ...timestampedFields,
};

export const inventoryEntryOut = z.object(inventoryEntryFields);

const productInventoryEmbedFields = {
  id: productShortcode,
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
  id: productShortcode,
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
  id: locationShortcode,
  name: z.string(),
  /** Null when the location IS a product; the SKU carries its form factor. */
  type: locationType.nullable(),
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
  productId: productShortcode.optional(),
  locationId: locationShortcode.optional(),
  placement: inventoryPlacement
    .optional()
    .describe(
      "Flip between movable stock and a fixed installation. Installing something does not move it — the row keeps its location, it just stops being counted.",
    ),
});

// Input schema for updating inventory entries
export const inventoryUpdateInput = z.object({
  id: inventoryShortcode,
  data: inventoryUpdatePayloadData,
});

export type InventoryUpdateInput = z.infer<typeof inventoryUpdateInput>;

export const inventoryCreatePayloadData = z.object({
  productId: productShortcode,
  locationId: locationShortcode,
  amount: positiveAmount,
  placement: inventoryPlacement
    .optional()
    .describe("Defaults to 'stock'; pass 'installed' for a fixed fixture."),
});

// Schema for bulk inventory operations
const inventoryBulkOperationItem = z.object({
  id: inventoryShortcode.optional(),
  productId: productShortcode,
  locationId: locationShortcode,
  amount: positiveAmount,
});

export type InventoryBulkOperationItem = z.infer<
  typeof inventoryBulkOperationItem
>;

export const inventoryBulkOperationPayload = z.object({
  // All operations for a given location
  locationId: locationShortcode,
  items: z.array(inventoryBulkOperationItem),
  // When the snapshot was loaded — lets the server reject a stale commit that
  // would delete-on-omit entries another surface added since. Optional so other
  // callers (MCP, tests) are unaffected.
  loadedAt: z.date().optional(),
});

// Schema for bulk move operations (moving items between locations)
const bulkMoveItem = z.object({
  inventoryEntryId: inventoryShortcode,
  quantity: positiveAmount, // How much to move (can be less than total for partial moves)
});

export type BulkMoveItem = z.infer<typeof bulkMoveItem>;

export const bulkMovePayload = z.object({
  sourceLocationId: locationShortcode,
  targetLocationId: locationShortcode,
  items: z.array(bulkMoveItem).min(1),
});

export type BulkMovePayload = z.infer<typeof bulkMovePayload>;

// Move entries to per-item destinations. The general shape: reorganizing is
// inherently many-source→many-target (one shelf fanning out across a dozen
// drawers), which `bulkMovePayload` above cannot express — it pins ONE source
// and ONE target for the whole call, so the UI had to group a selection by
// source location and fire a separate request per group.
//
// The source is not asked for because it is not information the caller has to
// supply: an entry already knows the location it sits in.
const moveInventoryItem = z.object({
  inventoryEntryId: inventoryShortcode,
  targetLocationId: locationShortcode,
  // Omit to move the entry entirely. Present = a partial move, leaving the
  // remainder behind. Listing one entry twice with two quantities is how a bin
  // gets split across several destinations.
  quantity: positiveAmount.optional(),
});

export type MoveInventoryItem = z.infer<typeof moveInventoryItem>;

export const moveInventoryEntriesPayload = z.object({
  items: z.array(moveInventoryItem).min(1).max(200),
});

export type MoveInventoryEntriesPayload = z.infer<
  typeof moveInventoryEntriesPayload
>;

// One staged decision about an expected row, committed atomically on "Done".
// `verify` = confirmed present as-is; `adjust` = present at a corrected count;
// `remove` = not here, soft-delete it; `relocate` = move the full row to the
// selected location (merging with an existing same-product row when needed).
export const inventorySessionResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("verify"), inventoryEntryId: inventoryShortcode }),
  z.object({
    kind: z.literal("adjust"),
    inventoryEntryId: inventoryShortcode,
    // positiveAmount (not amount): a recount to zero is a Remove, not an
    // adjust — this keeps the value > 0 invariant every other write enforces.
    amount: positiveAmount,
  }),
  z.object({ kind: z.literal("remove"), inventoryEntryId: inventoryShortcode }),
  z.object({
    kind: z.literal("relocate"),
    inventoryEntryId: inventoryShortcode,
    targetLocationId: locationShortcode,
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
  locationId: locationShortcode,
  expectedInventoryEntryIds: z.array(inventoryShortcode),
  snapshotUpdatedAt: z.date().nullable(),
  resolutions: z.array(inventorySessionResolution),
});

export type ReconcileSessionPayload = z.infer<typeof reconcileSessionPayload>;

export const inventoryFindDuplicatesInput = z.object({
  excludeLocationId: locationShortcode.optional(),
});

export const inventoryLocationIdsInput = z.object({
  locationIds: z.array(locationShortcode),
  // Defaults to "all" rather than the browse default, because the two callers
  // want opposite things: an audit session passes "stock" (a recount cannot
  // include fixtures, and its predicate must match the snapshot queries in
  // reconcileLocationSession or the stale guard compares two populations), and
  // the location card grid wants everything it has always had.
  placement: inventoryPlacementFilter.optional(),
});

const inventoryMcpProductFields = {
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  category: productCategory.nullable(),
  model: z.string().nullable(),
};

const inventoryMcpLocationFields = {
  id: locationShortcode,
  name: z.string(),
};

/** Slim MCP projection of an inventory list/detail row. */
export const inventoryMcpOut = z.object({
  id: inventoryShortcode,
  amount,
  valuation: z.number().nullable(),
  // Without this an agent can SET placement but never see it, so it cannot tell
  // a fixture from stock when deciding what to recount, move, or discard.
  placement: inventoryPlacement,
  product: z.object(inventoryMcpProductFields).nullable(),
  location: z.object(inventoryMcpLocationFields).nullable(),
});
export type InventoryMcpOut = z.infer<typeof inventoryMcpOut>;

export const inventoryMcpListOut =
  createPaginatedResponseSchema(inventoryMcpOut);
export const inventoryMcpBulkMoveOut =
  createItemsResponseSchema(inventoryMcpOut);
