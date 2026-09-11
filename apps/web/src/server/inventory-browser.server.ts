import { inventoryContract } from "~/contracts/inventory.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  bulkAddInventoryWorkflow,
  bulkDiscardInventoryWorkflow,
  bulkMoveInventoryWorkflow,
  bulkProcessInventoryWorkflow,
  findInventoryDuplicatesWorkflow,
  getInventoryByLocationIdsWorkflow,
  moveInventoryEntriesWorkflow,
  reconcileInventorySessionWorkflow,
  resolveInventoryScanStraysWorkflow,
  scanInventoryAtLocationWorkflow,
} from "~/server/workflows/inventory.server";

export const inventoryHandlers = implementOperationDomain(inventoryContract, {
  bulkProcess: (context, input) =>
    bulkProcessInventoryWorkflow(context.db, context.actorContext, input),
  bulkAdd: (context, input) =>
    bulkAddInventoryWorkflow(context.db, context.actorContext, input),
  bulkDiscard: (context, input) => bulkDiscardInventoryWorkflow(context, input),
  bulkMove: (context, input) =>
    bulkMoveInventoryWorkflow(context.db, context.actorContext, input),
  moveEntries: (context, input) =>
    moveInventoryEntriesWorkflow(context.db, context.actorContext, input),
  reconcileSession: (context, input) =>
    reconcileInventorySessionWorkflow(context.db, context.actorContext, input),
  scanAtLocation: (context, input) =>
    scanInventoryAtLocationWorkflow(context, input),
  resolveScanStrays: (context, input) =>
    resolveInventoryScanStraysWorkflow(context.db, context.actorContext, input),
  findDuplicates: (context, input) =>
    findInventoryDuplicatesWorkflow(context.db, input),
  getByLocationIds: (context, input) =>
    getInventoryByLocationIdsWorkflow(context.db, input),
});
