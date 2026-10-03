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
    native: "Explicit Expense inventory receiving",
    input: inventoryReceiveExpenseInput,
    output: inventoryReceiveExpenseOut,
    invalidates: ["inventory", "product", "purchase", "problems"],
  }),
  receivingContext: query({
    native: "Expense receiving context",
    input: inventoryReceivingContextInput,
    output: inventoryReceivingContextOut,
  }),
  bulkAdd: mutation({
    native: "Add to inventory from the hero action",
    input: inventoryBulkAddPayload,
    output: inventoryBulkAddOut,
    invalidates: ["inventory"],
  }),
  bulkDiscard: mutation({
    input: inventoryBulkDiscardPayload,
    output: inventoryBulkDiscardOut,
    invalidates: ["expense"],
  }),
  bulkMove: mutation({
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
    native: "Audit reconcile",
    input: reconcileSessionPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ["inventory"],
  }),
  scanAtLocation: mutation({
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
    readPolicy: "strong",
    native: "Audit duplicate badge",
    input: inventoryFindDuplicatesInput,
    output: inventoryDuplicateUniqueProductsOut,
  }),
  getByLocationIds: query({
    readPolicy: "strong",
    native: "Audit bin rows",
    input: inventoryLocationIdsInput,
    output: inventoryWithLocationAndProductListOut,
  }),
  locationSnapshot: query({
    native: "Ownership-aware inventory snapshot",
    input: inventoryLocationSnapshotInput,
    output: inventoryLocationSnapshotOut,
  }),
  setOwnership: mutation({
    native: "Set inventory owner",
    input: setInventoryOwnershipInput,
    output: inventoryOwnershipMutationOut,
    invalidates: ["inventory"],
  }),
  confirmOwnership: mutation({
    native: "Confirm inherited inventory owner",
    input: confirmInventoryOwnershipInput,
    output: inventoryOwnershipMutationOut,
    invalidates: ["inventory"],
  }),
});
