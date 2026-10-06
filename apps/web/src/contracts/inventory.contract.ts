import {
  bulkMovePayload,
  inventoryBulkAddOut,
  inventoryBulkAddPayload,
  inventoryBulkDiscardOut,
  inventoryBulkDiscardPayload,
  inventoryDuplicateUniqueProductsOut,
  inventoryFindDuplicatesInput,
  inventoryLocationIdsInput,
  inventoryLocationSnapshotInput,
  inventoryLocationSnapshotOut,
  inventoryWithLocationAndProductListAndSideEffectsOut,
  inventoryWithLocationAndProductListOut,
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
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    native: "Explicit Expense inventory receiving",
    input: inventoryReceiveExpenseInput,
    output: inventoryReceiveExpenseOut,
    invalidates: ["inventory", "product", "purchase", "problems"],
  }),
  receivingContext: query({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    native: "Expense receiving context",
    input: inventoryReceivingContextInput,
    output: inventoryReceivingContextOut,
  }),
  bulkAdd: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["create", "commands"],
      note: "entity.create or entity.commands on inventory",
    },
    native: "Add to inventory from the hero action",
    input: inventoryBulkAddPayload,
    output: inventoryBulkAddOut,
    invalidates: ["inventory"],
  }),
  bulkDiscard: mutation({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    input: inventoryBulkDiscardPayload,
    output: inventoryBulkDiscardOut,
    invalidates: ["expense"],
  }),
  bulkMove: mutation({
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
    native: "Accept inventory placement recommendation",
    input: moveInventoryEntriesPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ["inventory"],
  }),
  reconcileSession: mutation({
    mcp: {
      omit: "human_approval",
      note: "A person attests a physical shelf audit",
    },
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
    mcp: {
      omit: "human_approval",
      note: "A person resolves strays found while scanning",
    },
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
  getByLocationIds: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["list"],
      note: "entity_read.list on inventory filtered by locationId",
    },
    readPolicy: "strong",
    native: "Audit bin rows",
    input: inventoryLocationIdsInput,
    output: inventoryWithLocationAndProductListOut,
  }),
  locationSnapshot: query({
    mcp: { omit: "client_view" },
    native: "Ownership-aware inventory snapshot",
    input: inventoryLocationSnapshotInput,
    output: inventoryLocationSnapshotOut,
  }),
  setOwnership: mutation({
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
    mcp: { omit: "human_approval" },
    native: "Confirm inherited inventory owner",
    input: confirmInventoryOwnershipInput,
    output: inventoryOwnershipMutationOut,
    invalidates: ["inventory"],
  }),
});
