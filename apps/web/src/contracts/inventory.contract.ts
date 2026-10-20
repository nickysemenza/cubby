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

export const inventoryContract = defineContract("inventory", {
  receiveExpense: mutation({
    command: { label: "Receive inventory", confirmation: null },
    mcp: {
      omit: "deferred_capability",
    },
    native: "Explicit Expense inventory receiving",
    input: inventoryReceiveExpenseInput,
    output: inventoryReceiveExpenseOut,
    invalidates: ["inventory", "product", "purchase", "problems"],
  }),
  receivingContext: query({
    mcp: {
      omit: "deferred_capability",
    },
    native: "Expense receiving context",
    input: inventoryReceivingContextInput,
    output: inventoryReceivingContextOut,
  }),
  bulkAdd: mutation({
    command: {
      label: "Add inventory",
      confirmation: null,
      affectedEntities: ["inventory", "location", "product"],
      resultFields: [
        { label: "Created", path: "createdCount" },
        { label: "Merged", path: "mergedCount" },
      ],
    },
    mcp: {
      omit: "deferred_capability",
      note: "Atomic add-or-sum is distinct from strict entity.create; user commands call inventory.bulkAdd",
    },
    native: "Add to inventory from the hero action",
    input: inventoryBulkAddPayload,
    output: inventoryBulkAddOut,
    invalidates: ["inventory"],
  }),
  bulkDiscard: mutation({
    command: { label: "Discard inventory", confirmation: null },
    mcp: {
      omit: "deferred_capability",
    },
    input: inventoryBulkDiscardPayload,
    output: inventoryBulkDiscardOut,
    invalidates: ["expense"],
  }),
  bulkMove: mutation({
    command: { label: "Move inventory", confirmation: null },
    mcp: {
      omit: "agent_twin",
      twin: "inventory.moveEntries",
      note: "The web multi-select move; entity.move_inventory moves entries per destination",
    },
    input: bulkMovePayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ["inventory"],
  }),
  moveEntries: mutation({
    command: { label: "Move inventory", confirmation: null },
    native: "Accept inventory placement recommendation",
    input: moveInventoryEntriesPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ["inventory"],
  }),
  reconcileSession: mutation({
    native: "Audit reconcile",
    input: reconcileSessionPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ["inventory"],
  }),
  scanAtLocation: mutation({
    mcp: { omit: "device_protocol", note: "Native barcode capture" },
    native: "Capture",
    input: scanAtLocationInput,
    output: scanAtLocationOut,
    invalidates: ["inventory"],
  }),
  resolveScanStrays: mutation({
    native: "Strays sheet",
    input: resolveScanStraysInput,
    output: resolveScanStraysOut,
    invalidates: ["inventory"],
  }),
  // Interactive inventory work and integrity/repair diagnostics.
  findDuplicates: query({
    mcp: { omit: "client_view" },
    readPolicy: "strong",
    native: "Audit duplicate badge",
    input: inventoryFindDuplicatesInput,
    output: inventoryDuplicateUniqueProductsOut,
  }),
  locationSnapshot: query({
    mcp: { omit: "client_view" },
    native: "Ownership-aware inventory snapshot",
    input: inventoryLocationSnapshotInput,
    output: inventoryLocationSnapshotOut,
  }),
  setOwnership: mutation({
    command: { label: "Set ownership", confirmation: null },
    mcp: {
      omit: "kernel_alternative",
      kernel: ["update"],
      note: "entity.update on inventory ownershipMode and ownerLedgerPartyId",
    },
    native: "Set inventory owner",
    input: setInventoryOwnershipInput,
    output: inventoryOwnershipMutationOut,
    invalidates: ["inventory"],
  }),
  confirmOwnership: mutation({
    command: { label: "Confirm ownership", confirmation: null },
    native: "Confirm inherited inventory owner",
    input: confirmInventoryOwnershipInput,
    output: inventoryOwnershipMutationOut,
    invalidates: ["inventory"],
  }),
});
