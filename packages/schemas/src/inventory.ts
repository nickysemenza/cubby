import { inventoryPlacementValues } from "@cubby/shared";
import { fdcId } from "@cubby/usda-schemas";
import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { inventoryRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  dateRangeFields,
  plainDate,
  timestampedFields,
} from "./base-entity";
import { mutationSideEffectsSchema } from "./background-jobs";
import { positiveAmount } from "./codec";
import { externalIdOut, gtin } from "./external-id";
import { moneyNullable } from "./money";
import { imageOut } from "./image";
import {
  expenseShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { locationOut, locationType } from "./location";
import { productCategory } from "./product";
import { duplicateUniqueProductSchema } from "./problems";
import {
  createItemsResponseSchema,
  createPaginatedResponseSchema,
  entityFilter,
  oneOrMany,
} from "./pagination";
import { unitMappingOut } from "./unitmapping";
import { inventoryPlacement as cycleSafeInventoryPlacement } from "./inventory-fields";
import { generatedInventoryItemFieldSchemas } from "./generated/entity-field-schemas.inventory.gen";
import { displayImagesField } from "./display-images";
import { inventoryOwnershipSelection } from "./inventory-ownership";

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
export const inventoryPlacement = cycleSafeInventoryPlacement;
export { inventoryValuation } from "./inventory-fields";

/**
 * Tri-state, and explicitly NOT `inventoryPlacement.optional()`.
 *
 * "Empty filter field means unrestricted" is the repo-wide rule, so an omitted
 * two-value filter would hand the UI the stock set while MCP `list_inventory`
 * and direct transport callers got the unfiltered one — the two disagreeing
 * silently is the exact class of bug this whole change exists to remove. The
 * default lives server-side in `inventoryentryList`.
 */
export const inventoryPlacementFilter = z.enum([
  ...inventoryPlacementValues,
  "all",
]);

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
  ...dateRangeFields("verified"),
};

export const inventoryFiltersSchema = z.object(inventoryFilterFields);

// `verifiedAt` (last deliberate recount, null = never) is sortable so "what
// haven't I counted in ages?" is one click — NULLS LAST in both directions per
// the house rule.
export type InventorySortField = GeneratedEntitySortField<"inventory">;

export const inventoryEntryFields = {
  ...generatedInventoryItemFieldSchemas.read,
};

export const inventoryEntryOut = z.object(inventoryEntryFields);

/**
 * `"<product name> · <location name>"`, or just the product name when the
 * entry carries no location. Inventory has no name column of its own, so this
 * is the canonical non-null title wherever a row's product/location join is
 * loaded (list and detail reads); the bare entity output has neither join and
 * is not given a display name.
 */
export const inventoryDisplayName = ({
  productName,
  locationName,
}: {
  productName: string;
  locationName?: string | null;
}): string => (locationName ? `${productName} · ${locationName}` : productName);

const productInventoryEmbedFields = {
  id: productShortcode,
  name: z.string(),
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId.nullable(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  category: productCategory.nullable(),
  price: moneyNullable,
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
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId.nullable(),
  category: productCategory.nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  model: z.string().nullable(),
  price: moneyNullable,
  usdaUnavailable: z.boolean().nullable(),
});
export type InventoryListProductOut = z.infer<typeof inventoryListProductOut>;

export const inventoryListLocationOut = z.object({
  id: locationShortcode,
  name: z.string(),
  type: locationType.nullable(),
});
export type InventoryListLocationOut = z.infer<typeof inventoryListLocationOut>;

const inventoryListItemFields = {
  ...inventoryEntryFields,
  displayImages: displayImagesField,
  product: inventoryListProductOut,
  location: inventoryListLocationOut,
  displayName: z.string(),
};

export const inventoryListItemOut = z.object(inventoryListItemFields);
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
  displayName: z.string(),
};

export const inventoryWithLocationAndProductOut = z.object(
  inventoryWithLocationAndProductFields,
);
export type InventoryWithLocationAndProductOut = z.infer<
  typeof inventoryWithLocationAndProductOut
>;

/** Generic MCP entity detail with storage-only product child ids removed. */
export const inventoryWithLocationAndProductMcpEntityOut =
  inventoryWithLocationAndProductOut.extend({
    product: inventoryDetailProductOut.extend({
      externalIds: z.array(externalIdOut.omit({ id: true })),
      unitMappings: z.array(unitMappingOut.omit({ id: true })),
    }),
  });

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

export const inventoryUpdatePayloadData = z
  .object(generatedInventoryItemFieldSchemas.update)
  .superRefine((value, context) => {
    if (
      value.ownershipMode !== undefined &&
      value.ownerLedgerPartyId !== undefined &&
      (value.ownershipMode === "person") !== (value.ownerLedgerPartyId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownerLedgerPartyId"],
        message: "Person ownership requires an owner; other modes clear it",
      });
    }
  });

export const inventoryUpdateInput = z.object({
  id: inventoryShortcode,
  data: inventoryUpdatePayloadData,
});

export type InventoryUpdateInput = z.infer<typeof inventoryUpdateInput>;

export const inventoryCreatePayloadData = z
  .object(generatedInventoryItemFieldSchemas.create)
  .superRefine((value, context) => {
    if (
      (value.ownershipMode === "person") !==
      (value.ownerLedgerPartyId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownerLedgerPartyId"],
        message: "Person ownership requires an owner; other modes clear it",
      });
    }
  });

const inventoryBulkOperationItem = z.object({
  id: inventoryShortcode.optional(),
  productId: productShortcode,
  locationId: locationShortcode,
  amount: positiveAmount,
  ownership: inventoryOwnershipSelection.optional(),
});

export type InventoryBulkOperationItem = z.infer<
  typeof inventoryBulkOperationItem
>;

export const inventoryBulkOperationPayload = z.object({
  locationId: locationShortcode,
  items: z.array(inventoryBulkOperationItem),
  // When the snapshot was loaded — lets the server reject a stale commit that
  // would delete-on-omit entries another surface added since. Optional so other
  // callers (MCP, tests) are unaffected.
  loadedAt: z.coerce.date<Date | string>().optional(),
  snapshotToken: z.string().min(1).optional(),
});

/**
 * One product to stock at a shared location.
 *
 * Deliberately NOT `inventoryBulkOperationItem`: that one carries its own
 * `locationId` per item and an optional entry `id`, because `bulkProcess`
 * reconciles a whole shelf. This is additive — every item lands at the one
 * `locationId` on the payload, and there is no entry id because the caller is
 * naming products, not rows.
 */
const inventoryBulkAddItem = z.object({
  productId: productShortcode,
  amount: positiveAmount,
  placement: inventoryPlacement
    .optional()
    .describe("Defaults to 'stock'; pass 'installed' for a fixed fixture."),
  ownership: inventoryOwnershipSelection.optional(),
});

export type InventoryBulkAddItem = z.infer<typeof inventoryBulkAddItem>;

/**
 * Stock many products at one location in a single transaction.
 *
 * Additive, unlike `inventoryBulkOperationPayload`: nothing already at the
 * location is touched unless an item names its product, and an item whose slot
 * `(productId, locationId, placement)` is already occupied SUMS into that row
 * rather than colliding with the partial unique index.
 */
export const inventoryBulkAddPayload = z.object({
  locationId: locationShortcode,
  items: z.array(inventoryBulkAddItem).min(1),
});

/**
 * `createdCount` + `mergedCount` rather than a flag per row: the caller needs
 * them to tell the operator how much of a submission merged into stock that
 * was already there, and deriving that client-side would mean trusting a
 * preview taken before the write.
 */
export const inventoryBulkAddOut = z.object({
  items: inventoryWithLocationAndProductListOut,
  createdCount: z.number().int().nonnegative(),
  mergedCount: z.number().int().nonnegative(),
  sideEffects: mutationSideEffectsSchema,
});

/**
 * One shelf row to write off, and how much of it.
 *
 * No `productId`: an entry already names its product, which is the whole
 * reason discarding from an inventory surface is simpler than discarding from
 * a product one. `productDiscardInput` has to ask which shelf because a
 * product may sit on several; a selection of entries has already answered
 * that per row.
 */
const inventoryBulkDiscardItem = z.object({
  inventoryEntryId: inventoryShortcode,
  quantity: z
    .number()
    .positive()
    .describe(
      "Units leaving the household from this entry, as a positive count. May be fractional. Stored on the Expense as a NEGATIVE productQuantity.",
    ),
});

/**
 * Write off units from many shelf rows in one transaction.
 *
 * N items mint N zero-cost Expenses carrying negative `productQuantity` — one
 * ledger line per row, which is what a discard IS; there is no combined line
 * to write. Date and reason are shared because they describe the event, not
 * the row.
 *
 * Unlike `productDiscardInput` there is no `adjustInventory` opt-out: the
 * caller selected shelf rows, so "take it off that shelf" is the request. A
 * ledger-only write-off is still available from the product surfaces.
 */
export const inventoryBulkDiscardPayload = z.object({
  items: z.array(inventoryBulkDiscardItem).min(1),
  date: plainDate,
  reason: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .describe(
      "Free text stored as each Expense's notes — broken, thrown away, given away.",
    ),
});
export type InventoryBulkDiscardPayload = z.infer<
  typeof inventoryBulkDiscardPayload
>;

/**
 * One result row per submitted item, in submission order.
 *
 * `removed` distinguishes "the entry emptied and was soft-deleted" from "the
 * entry was drawn down" — the caller cannot derive it, because the amount it
 * held was read inside the transaction.
 */
export const inventoryBulkDiscardOut = z.object({
  items: z.array(
    z.object({
      inventoryEntryId: inventoryShortcode,
      productId: productShortcode,
      expenseId: expenseShortcode,
      storedQuantity: z.number().negative(),
      removed: z.boolean(),
      remainingValue: z.number().nullable(),
    }),
  ),
  sideEffects: mutationSideEffectsSchema,
});

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
  // Nullish, not nullable: a generated client's synthesized encoder omits the
  // key for an empty bin (no rows, so no snapshot), and that must still commit.
  snapshotUpdatedAt: z.coerce
    .date<Date | string>()
    .nullish()
    .transform((value) => value ?? null),
  snapshotToken: z.string().min(1).optional(),
  resolutions: z.array(inventorySessionResolution),
});

export const inventoryLocationSnapshotInput = z.object({
  locationId: locationShortcode,
  placement: generatedInventoryItemFieldSchemas.read.placement.default("stock"),
});

export const inventoryLocationSnapshotOut = z.object({
  items: inventoryWithLocationAndProductListOut,
  snapshotToken: z.string().min(1),
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

/**
 * Slim MCP projection of an inventory list/detail row: built from the same
 * field map as `inventoryListItemOut` minus the audit columns, so it cannot
 * drift from the plain shape. `product` and `location` are REQUIRED here as
 * they are there — a live entry always resolves both through its FK join.
 * `placement` is kept because an agent that can SET it but never see it
 * cannot tell a fixture from stock when deciding what to recount, move, or
 * discard.
 */
export const inventoryMcpOut = z.object({
  id: inventoryListItemFields.id,
  amount: inventoryListItemFields.amount,
  valuation: inventoryListItemFields.valuation,
  placement: inventoryListItemFields.placement,
  product: inventoryListItemFields.product,
  location: inventoryListItemFields.location,
});
export type InventoryMcpOut = z.infer<typeof inventoryMcpOut>;

export const inventoryMcpListOut =
  createPaginatedResponseSchema(inventoryMcpOut);
export const inventoryMcpBulkMoveOut =
  createItemsResponseSchema(inventoryMcpOut);
