import { inventoryFieldEnvelopeSchemas } from "./generated/entity-field-envelopes.inventory.gen";
import {
  inventoryFieldEnvelopeFields,
  inventoryPublicReadFields,
} from "./generated/entity-field-envelope-fields.inventory.gen";
import {
  productFieldEnvelopeFields,
  productPublicReadFields,
} from "./generated/entity-field-envelope-fields.product.gen";
import { withFieldEnvelopes } from "./field-envelope";
import { rawReceivingInventoryStock } from "./inventory-raw-read";
import { tradeSchema } from "./task-fields";
import { inventoryPlacementValues } from "@cubby/shared";
import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { inventoryRelatedFilterFields } from "./related-view";
import { auditDateFilterFields, plainDate } from "./base-entity";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import { positiveAmount } from "./codec";
import { productMatchSide, productMatchSource } from "./recommendations";
import {
  expenseShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { duplicateUniqueProductSchema } from "./problems";
import { inventoryPlacement as cycleSafeInventoryPlacement } from "./inventory-fields";
import {
  generatedInventoryItemFieldSchemas,
  generatedInventoryItemFilterFields,
} from "./generated/entity-field-schemas.inventory.gen";
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
 * The inventory snapshot's placement scope:
 * one placement, or `all`. List filters are any-of over the placements
 * instead, and an omitted list filter is unrestricted; the inventory list
 * opens on stock through its declared `initialFilter`.
 */
export const inventoryPlacementFilter = z.enum([
  ...inventoryPlacementValues,
  "all",
]);

export const inventoryFilterFields = {
  ...auditDateFilterFields,
  ...inventoryRelatedFilterFields,
  ...generatedInventoryItemFilterFields,
};

export const inventoryFiltersSchema = z.object(inventoryFilterFields);

// `verifiedAt` (last deliberate recount, null = never) is sortable so "what
// haven't I counted in ages?" is one click — NULLS LAST in both directions per
// the house rule.
export type InventorySortField = GeneratedEntitySortField<"inventory">;

export const inventoryEntryOut = inventoryFieldEnvelopeSchemas.output;

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

export const inventoryListItemOut = inventoryFieldEnvelopeSchemas.list;
export type InventoryListItemOut = z.output<typeof inventoryListItemOut>;
export const inventoryListProductOut = inventoryListItemOut.shape.product;
export type InventoryListProductOut = z.output<typeof inventoryListProductOut>;
export const inventoryListLocationOut = inventoryListItemOut.shape.location;
export type InventoryListLocationOut = z.output<
  typeof inventoryListLocationOut
>;
export const inventoryWithLocationAndProductOut =
  inventoryFieldEnvelopeSchemas.detail;
export const inventoryDetailProductOut =
  inventoryWithLocationAndProductOut.shape.product;
const inventoryWithLocationAndProductFields =
  inventoryWithLocationAndProductOut.shape;
export type InventoryWithLocationAndProductOut = z.output<
  typeof inventoryWithLocationAndProductOut
>;
export const inventoryWithLocationAndProductMcpEntityOut =
  inventoryFieldEnvelopeSchemas.mcpDetail;

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

export const inventoryDuplicateUniqueProductOut = withFieldEnvelopes(
  duplicateUniqueProductSchema,
  { brandName: productFieldEnvelopeFields.brandName },
  productPublicReadFields,
);
export const inventoryDuplicateUniqueProductsOut = z.array(
  inventoryDuplicateUniqueProductOut,
);

export const inventoryCountsByLocationOut = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

export const inventoryUpdatePayloadData = z
  .object(generatedInventoryItemFieldSchemas.update)
  .superRefine((value, context) => {
    if (
      value.ownershipMode === "inherit" &&
      value.ownerLedgerPartyId !== undefined &&
      value.ownerLedgerPartyId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownerLedgerPartyId"],
        message: "Inherited ownership cannot retain an owner",
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
    if (value.ownershipMode === "inherit" && value.ownerLedgerPartyId != null) {
      context.addIssue({
        code: "custom",
        path: ["ownerLedgerPartyId"],
        message: "Inherited ownership cannot retain an owner",
      });
    }
  });

/** One product to stock at a shared location; every item lands at the payload `locationId`. */
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
 * Additive: nothing already at the
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

/** Explicit receiving of one live Expense Product; purchasing never stocks inventory. */
const inventoryReceiveAmount = positiveAmount.refine(
  (amount) => amount.upperValue === undefined,
  {
    error: "Inventory receiving requires a point amount, not a range",
    path: ["upperValue"],
  },
);
export const inventoryReceiveExpenseInput = z.object({
  expenseId: expenseShortcode,
  expectedProductId: productShortcode,
  locationId: locationShortcode,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("move"), entryId: inventoryShortcode }),
    z.object({
      kind: z.literal("add"),
      entryId: inventoryShortcode,
      amount: inventoryReceiveAmount,
    }),
    z.object({ kind: z.literal("create"), amount: inventoryReceiveAmount }),
  ]),
});
export type InventoryReceiveExpenseInput = z.infer<
  typeof inventoryReceiveExpenseInput
>;
/**
 * What already counts for an Expense's Product before anything is received:
 * its own live stock, and open Product match candidates (agent proposals and
 * detector pairs) that may be the same item already counted, e.g. a photo
 * import. Read-only; receiving stays an explicit separate act.
 */
export const inventoryReceivingContextInput = z.object({
  productId: productShortcode,
});
/**
 * What "receive" will do. `move`: a one-of-a-kind item already on one shelf
 * relocates (`fromLocationId` is the shelf it cannot move to). `add`: the
 * chosen shelf already holds the Product, so top up that entry in its unit.
 * `create`: a new entry at the chosen shelf.
 */
export const inventoryReceivingPlan = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("move"),
    entryId: inventoryShortcode,
    fromLocationId: locationShortcode,
  }),
  z.object({
    kind: z.literal("add"),
    entryId: inventoryShortcode,
    unit: z.string(),
  }),
  z.object({ kind: z.literal("create") }),
]);
export const inventoryReceivingStockOut = withFieldEnvelopes(
  rawReceivingInventoryStock,
  inventoryFieldEnvelopeFields,
  inventoryPublicReadFields,
);
export const inventoryReceivingContextOut = z.object({
  productId: productShortcode,
  /**
   * Server-owned receiving defaults, rendered as-is by every client: the
   * shelf (or a stocked match) already counts this Product; the quantity to
   * prefill (`null` when counted, so units are never added without typing);
   * the unit for a new entry; the plan at a shelf with no entry of this
   * Product (`suggestedPlan`) and the plan at each shelf that has one
   * (`locationPlans`, which overrides `suggestedPlan` for that location).
   */
  alreadyCounted: z.boolean(),
  defaultQuantity: z.number().positive().nullable(),
  defaultUnit: z.string(),
  suggestedPlan: inventoryReceivingPlan,
  locationPlans: z.array(
    z.object({ locationId: locationShortcode, plan: inventoryReceivingPlan }),
  ),
  stock: z.array(inventoryReceivingStockOut),
  matches: z.array(
    z.object({
      source: productMatchSource,
      evidence: z.string().nullable(),
      candidate: productMatchSide,
      warnings: z.array(z.string()),
    }),
  ),
});
export type InventoryReceivingContextOut = z.infer<
  typeof inventoryReceivingContextOut
>;
export const inventoryReceiveExpenseOut = z.object({
  item: inventoryWithLocationAndProductOut,
  resolvedArrivedFindings: z.number().int().nonnegative(),
  sideEffects: mutationSideEffectsSchema,
});
export type InventoryReceiveExpenseOut = z.infer<
  typeof inventoryReceiveExpenseOut
>;

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
  trade: tradeSchema,
  items: z.array(inventoryBulkDiscardItem).min(1),
  date: plainDate.nullable().describe("Discard date; null when unknown."),
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
  placement: inventoryPlacement.default("stock"),
});

export const inventoryLocationSnapshotOut = z.object({
  items: inventoryWithLocationAndProductListOut,
  snapshotToken: z.string().min(1),
});

export type ReconcileSessionPayload = z.infer<typeof reconcileSessionPayload>;

export const inventoryFindDuplicatesInput = z.object({
  excludeLocationId: locationShortcode.optional(),
});
