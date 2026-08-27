import {
  bulkMovePayload,
  inventoryBulkAddOut,
  inventoryBulkAddPayload,
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
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const inventory = defineOperationDomain("inventory", {
  bulkProcess: mutation({
    input: inventoryBulkOperationPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ripple.inventory,
  }),
  bulkAdd: mutation({
    input: inventoryBulkAddPayload,
    output: inventoryBulkAddOut,
    invalidates: [["inventory"]],
  }),
  bulkMove: mutation({
    input: bulkMovePayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ripple.inventory,
  }),
  moveEntries: mutation({
    input: moveInventoryEntriesPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ripple.inventory,
  }),
  reconcileSession: mutation({
    input: reconcileSessionPayload,
    output: inventoryWithLocationAndProductListAndSideEffectsOut,
    invalidates: ripple.inventory,
  }),
  scanAtLocation: mutation({
    input: scanAtLocationInput,
    output: scanAtLocationOut,
    invalidates: ripple.inventory,
  }),
  resolveScanStrays: mutation({
    input: resolveScanStraysInput,
    output: resolveScanStraysOut,
    invalidates: ripple.inventory,
  }),
  findDuplicates: query({
    input: inventoryFindDuplicatesInput,
    output: inventoryDuplicateUniqueProductsOut,
    tags: [["inventory", "findDuplicates"]],
  }),
  getByLocationIds: query({
    input: inventoryLocationIdsInput,
    output: inventoryWithLocationAndProductListOut,
    tags: [["inventory", "getByLocationIds"]],
  }),
});
