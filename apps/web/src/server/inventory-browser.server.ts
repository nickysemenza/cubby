import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  bulkAddInventoryWorkflow,
  bulkMoveInventoryWorkflow,
  bulkMovePayload,
  bulkProcessInventoryWorkflow,
  findInventoryDuplicatesWorkflow,
  getInventoryByLocationIdsWorkflow,
  inventoryBulkAddOut,
  inventoryBulkAddPayload,
  inventoryBulkOperationPayload,
  inventoryDuplicateUniqueProductsOut,
  inventoryFindDuplicatesInput,
  inventoryLocationIdsInput,
  inventoryWithLocationAndProductListAndSideEffectsOut,
  inventoryWithLocationAndProductListOut,
  moveInventoryEntriesPayload,
  moveInventoryEntriesWorkflow,
  reconcileInventorySessionWorkflow,
  reconcileSessionPayload,
  resolveInventoryScanStraysWorkflow,
  resolveScanStraysInput,
  resolveScanStraysOut,
  scanAtLocationInput,
  scanAtLocationOut,
  scanInventoryAtLocationWorkflow,
} from "~/server/workflows/inventory.server";

export const bulkProcessInventoryForBrowser = async (options: {
  data: z.input<typeof inventoryBulkOperationPayload>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.bulkProcess",
    type: "mutation",
    input: options.data,
    inputSchema: inventoryBulkOperationPayload,
    outputSchema: inventoryWithLocationAndProductListAndSideEffectsOut,
    request: options.request,
    run: (context, input) =>
      bulkProcessInventoryWorkflow(context.db, context.actorContext, input),
  });

export const bulkAddInventoryForBrowser = async (options: {
  data: z.input<typeof inventoryBulkAddPayload>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.bulkAdd",
    type: "mutation",
    input: options.data,
    inputSchema: inventoryBulkAddPayload,
    outputSchema: inventoryBulkAddOut,
    request: options.request,
    run: (context, input) =>
      bulkAddInventoryWorkflow(context.db, context.actorContext, input),
  });

export const bulkMoveInventoryForBrowser = async (options: {
  data: z.input<typeof bulkMovePayload>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.bulkMove",
    type: "mutation",
    input: options.data,
    inputSchema: bulkMovePayload,
    outputSchema: inventoryWithLocationAndProductListAndSideEffectsOut,
    request: options.request,
    run: (context, input) =>
      bulkMoveInventoryWorkflow(context.db, context.actorContext, input),
  });

export const moveInventoryEntriesForBrowser = async (options: {
  data: z.input<typeof moveInventoryEntriesPayload>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.moveEntries",
    type: "mutation",
    input: options.data,
    inputSchema: moveInventoryEntriesPayload,
    outputSchema: inventoryWithLocationAndProductListAndSideEffectsOut,
    request: options.request,
    run: (context, input) =>
      moveInventoryEntriesWorkflow(context.db, context.actorContext, input),
  });

export const reconcileInventorySessionForBrowser = async (options: {
  data: z.input<typeof reconcileSessionPayload>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.reconcileSession",
    type: "mutation",
    input: options.data,
    inputSchema: reconcileSessionPayload,
    outputSchema: inventoryWithLocationAndProductListAndSideEffectsOut,
    request: options.request,
    run: (context, input) =>
      reconcileInventorySessionWorkflow(
        context.db,
        context.actorContext,
        input,
      ),
  });

export const findInventoryDuplicatesForBrowser = async (options: {
  data: z.input<typeof inventoryFindDuplicatesInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.findDuplicates",
    type: "query",
    input: options.data,
    inputSchema: inventoryFindDuplicatesInput,
    outputSchema: inventoryDuplicateUniqueProductsOut,
    request: options.request,
    run: (context, input) => findInventoryDuplicatesWorkflow(context.db, input),
  });

export const getInventoryByLocationIdsForBrowser = async (options: {
  data: z.input<typeof inventoryLocationIdsInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.getByLocationIds",
    type: "query",
    input: options.data,
    inputSchema: inventoryLocationIdsInput,
    outputSchema: inventoryWithLocationAndProductListOut,
    request: options.request,
    run: (context, input) =>
      getInventoryByLocationIdsWorkflow(context.db, input),
  });

export const scanInventoryAtLocationForBrowser = async (options: {
  data: z.input<typeof scanAtLocationInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.scanAtLocation",
    type: "mutation",
    input: options.data,
    inputSchema: scanAtLocationInput,
    outputSchema: scanAtLocationOut,
    request: options.request,
    run: (context, input) => scanInventoryAtLocationWorkflow(context, input),
  });

export const resolveInventoryScanStraysForBrowser = async (options: {
  data: z.input<typeof resolveScanStraysInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "inventory.resolveScanStrays",
    type: "mutation",
    input: options.data,
    inputSchema: resolveScanStraysInput,
    outputSchema: resolveScanStraysOut,
    request: options.request,
    run: (context, input) =>
      resolveInventoryScanStraysWorkflow(
        context.db,
        context.actorContext,
        input,
      ),
  });
