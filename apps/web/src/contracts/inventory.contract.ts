import {
  bulkMovePayload,
  inventoryBulkAddOut,
  inventoryBulkAddPayload,
  inventoryBulkDiscardOut,
  inventoryBulkDiscardPayload,
  inventoryDuplicateUniqueProductsOut,
  inventoryFindDuplicatesInput,
  inventoryLocationSnapshotInput,
  inventoryLocationSnapshotOut,
  inventoryWithLocationAndProductListAndSideEffectsOut,
  moveInventoryEntriesPayload,
  reconcileSessionPayload,
  inventoryReceiveExpenseInput,
  inventoryReceiveExpenseOut,
  inventoryReceivingContextInput,
  inventoryReceivingContextOut,
} from "@cubby/schemas/inventory";
import {
  confirmInventoryOwnershipInput,
  inventoryOwnershipMutationOut,
  setInventoryOwnershipInput,
} from "@cubby/schemas/inventory-ownership";
import {
  resolveScanStraysInput,
  resolveScanStraysOut,
  scanAtLocationInput,
  scanAtLocationOut,
} from "@cubby/schemas/scan";

import { defineContract, mutation, query } from "~/contracts/define";

export const inventoryContract = defineContract(
  "inventory",
  {
    receiveExpense: mutation({
      description:
        "Receive the selected Purchase Expense quantity into an inventory location. This records stock and may merge it into an existing entry; inspect receiving_context first when the target is unclear.",
      command: { label: "Receive inventory", confirmation: null },
      input: inventoryReceiveExpenseInput,
      output: inventoryReceiveExpenseOut,
      invalidates: ["inventory", "product", "purchase", "problems"],
    }),
    receivingContext: query({
      description:
        "Read the purchase and inventory context for a proposed receipt, including existing matching stock. This is a preview; use receive_expense only for items the member confirms arrived.",
      input: inventoryReceivingContextInput,
      output: inventoryReceivingContextOut,
    }),
    bulkAdd: mutation({
      note: "Atomic add-or-sum is distinct from strict entity.create; user commands call inventory.bulkAdd",
      description:
        "Add or sum inventory entries atomically for a location. Existing matching Product entries increase rather than creating duplicates; use entity.create when an ordinary new entity is intended.",
      command: {
        label: "Add inventory",
        confirmation: null,
        affectedEntities: ["inventory", "location", "product"],
        resultFields: [
          { label: "Created", path: "createdCount" },
          { label: "Merged", path: "mergedCount" },
        ],
      },
      input: inventoryBulkAddPayload,
      output: inventoryBulkAddOut,
      invalidates: ["inventory"],
    }),
    bulkDiscard: mutation({
      description:
        "Discard the selected inventory quantities. This reduces recorded stock and cannot be inferred from cooking or ordinary use; call only for a member-confirmed recount or discard.",
      destructive: true,
      command: { label: "Discard inventory", confirmation: null },
      input: inventoryBulkDiscardPayload,
      output: inventoryBulkDiscardOut,
      invalidates: ["expense"],
    }),
    bulkMove: mutation({
      exposure: "view",
      note: "The web multi-select move; inventory.move_entries moves entries per destination",
      command: { label: "Move inventory", confirmation: null },
      input: bulkMovePayload,
      output: inventoryWithLocationAndProductListAndSideEffectsOut,
      invalidates: ["inventory"],
    }),
    moveEntries: mutation({
      description:
        "Move inventory entries to per-item destination locations in one atomic call. Each item names an entry and where it should end up, so one call can fan a location out across many, consolidate many into one, or both. Omit an item's quantity to move the whole entry; include it for a partial move, and list one entry twice to split it across destinations. Entries merge into an existing entry for the same product at the destination. The source location is not asked for — an entry already knows where it is.",
      destructive: true,
      command: { label: "Move inventory", confirmation: null },
      input: moveInventoryEntriesPayload,
      output: inventoryWithLocationAndProductListAndSideEffectsOut,
      invalidates: ["inventory"],
    }),
    reconcileSession: mutation({
      description:
        "Commit a physical shelf audit of one location: the expected entry ids, the snapshot read before counting, and a resolution per entry. Only when the member counted that shelf.",
      input: reconcileSessionPayload,
      output: inventoryWithLocationAndProductListAndSideEffectsOut,
      invalidates: ["inventory"],
    }),
    scanAtLocation: mutation({
      exposure: "view",
      note: "Native barcode capture",
      input: scanAtLocationInput,
      output: scanAtLocationOut,
      invalidates: ["inventory"],
    }),
    resolveScanStrays: mutation({
      description:
        "Move inventory entries a scan found out of place into targetLocationId (whole entries unless quantity is given).",
      input: resolveScanStraysInput,
      output: resolveScanStraysOut,
      invalidates: ["inventory"],
    }),
    // Interactive inventory work and integrity/repair diagnostics.
    findDuplicates: query({
      exposure: "view",
      readPolicy: "strong",
      input: inventoryFindDuplicatesInput,
      output: inventoryDuplicateUniqueProductsOut,
    }),
    locationSnapshot: query({
      exposure: "view",
      input: inventoryLocationSnapshotInput,
      output: inventoryLocationSnapshotOut,
    }),
    setOwnership: mutation({
      exposure: "view",
      note: "entity.update on inventory ownershipMode and ownerLedgerPartyId",
      command: { label: "Set ownership", confirmation: null },
      input: setInventoryOwnershipInput,
      output: inventoryOwnershipMutationOut,
      invalidates: ["inventory"],
    }),
    confirmOwnership: mutation({
      description:
        "Confirm an inventory entry's inherited owner using the evidenceFingerprint its ownership context returned; quantity confirms part of the entry.",
      command: { label: "Confirm ownership", confirmation: null },
      input: confirmInventoryOwnershipInput,
      output: inventoryOwnershipMutationOut,
      invalidates: ["inventory"],
    }),
  },
  { exposure: "capability" },
);
