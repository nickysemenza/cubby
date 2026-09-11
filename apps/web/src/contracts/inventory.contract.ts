import {
  bulkMovePayload,
  inventoryBulkAddOut,
  inventoryBulkAddPayload,
  inventoryBulkDiscardOut,
  inventoryBulkDiscardPayload,
  inventoryBulkOperationPayload,
  inventoryDuplicateUniqueProductsOut,
  inventoryFindDuplicatesInput,
  inventoryLocationIdsInput,
  inventoryWithLocationAndProductListAndSideEffectsOut,
  inventoryWithLocationAndProductListOut,
  moveInventoryEntriesPayload,
  reconcileSessionPayload,
} from "@cubby/schemas/inventory";
import {
  resolveScanStraysInput,
  resolveScanStraysOut,
  scanAtLocationInput,
  scanAtLocationOut,
} from "@cubby/schemas/scan";

import { defineContract, mutation, query } from "~/contracts/define";

export const inventoryContract = defineContract("inventory", {
  bulkProcess: mutation({
    input: inventoryBulkOperationPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
  }),
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
    input: moveInventoryEntriesPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
  }),
  reconcileSession: mutation({
    input: reconcileSessionPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
  }),
  scanAtLocation: mutation({
    input: scanAtLocationInput,
    output: scanAtLocationOut,
  }),
  resolveScanStrays: mutation({
    input: resolveScanStraysInput,
    output: resolveScanStraysOut,
  }),
  findDuplicates: query({
    input: inventoryFindDuplicatesInput,
    output: inventoryDuplicateUniqueProductsOut,
  }),
  getByLocationIds: query({
    input: inventoryLocationIdsInput,
    output: inventoryWithLocationAndProductListOut,
  }),
});
