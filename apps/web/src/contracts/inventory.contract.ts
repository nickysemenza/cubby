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
  bulkAdd: mutation({
    input: inventoryBulkAddPayload,
    output: inventoryBulkAddOut,
  }),
  bulkDiscard: mutation({
    input: inventoryBulkDiscardPayload,
    output: inventoryBulkDiscardOut,
  }),
  bulkMove: mutation({
    input: bulkMovePayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
  }),
  moveEntries: mutation({
    native: "Accept inventory placement recommendation",
    input: moveInventoryEntriesPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
  }),
  reconcileSession: mutation({
    native: "Audit reconcile",
    input: reconcileSessionPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
  }),
  scanAtLocation: mutation({
    native: "Capture",
    input: scanAtLocationInput,
    output: scanAtLocationOut,
  }),
  resolveScanStrays: mutation({
    native: "Strays sheet",
    input: resolveScanStraysInput,
    output: resolveScanStraysOut,
  }),
  findDuplicates: query({
    native: "Audit duplicate badge",
    input: inventoryFindDuplicatesInput,
    output: inventoryDuplicateUniqueProductsOut,
  }),
  getByLocationIds: query({
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
  }),
  confirmOwnership: mutation({
    native: "Confirm inherited inventory owner",
    input: confirmInventoryOwnershipInput,
    output: inventoryOwnershipMutationOut,
  }),
});
