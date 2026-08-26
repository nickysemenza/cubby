import type { z } from "zod";
import type { StartOperationResult } from "~/server/start-operation.contract";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  applyProductUpcDataWorkflow,
  attachProductComponentsWorkflow,
  bulkSetProductStockTrackedWorkflow,
  detachProductComponentsWorkflow,
  discardProductWorkflow,
  findOrCreateProductByCodeWorkflow,
  findOrCreateProductByUpcWorkflow,
  getProductCategoryDistributionWorkflow,
  getProductExternalIdSourceOptionsWorkflow,
  getProductInventoryEntriesWorkflow,
  getProductManufacturerOptionsWorkflow,
  getProductMovementTimelineWorkflow,
  getProductQuantitySummariesWorkflow,
  getProductSummariesWorkflow,
  getProductsByShortcodesWorkflow,
  getProductTagOptionsWorkflow,
  listKitComponentRowsWorkflow,
  listKitMembershipWorkflow,
  listProductComponentsWorkflow,
  listProductProjectUsesWorkflow,
  listProductPurchasesWorkflow,
  mergeProductsWorkflow,
  type ProductWorkflowContext,
  productWorkflowSchemas,
  quickCreateProductWorkflow,
  searchProductsWorkflow,
  setProductProjectUsesWorkflow,
} from "~/server/workflows/product.server";

const run = <
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(options: {
  operation: string;
  type: "query" | "mutation";
  schemas: { input: InputSchema; output: OutputSchema };
  data: z.input<InputSchema>;
  request: StartOperationRequest;
  workflow: (
    context: ProductWorkflowContext,
    input: z.output<InputSchema>,
  ) => Promise<unknown>;
}): Promise<StartOperationResult<z.output<OutputSchema>>> =>
  runStartOperation<InputSchema, unknown>({
    operation: options.operation,
    type: options.type,
    input: options.data,
    inputSchema: options.schemas.input,
    outputSchema: options.schemas.output,
    request: options.request,
    run: options.workflow,
  }).then((result) =>
    result.ok
      ? { ...result, data: options.schemas.output.parse(result.data) }
      : result,
  );

export const searchProductsForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.search.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.search",
    type: "query",
    schemas: productWorkflowSchemas.search,
    workflow: searchProductsWorkflow,
  });
export const getProductSummariesForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.summaries.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.summaries",
    type: "query",
    schemas: productWorkflowSchemas.summaries,
    workflow: getProductSummariesWorkflow,
  });
export const getProductQuantitySummariesForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.quantitySummaries.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.quantitySummaries",
    type: "query",
    schemas: productWorkflowSchemas.quantitySummaries,
    workflow: getProductQuantitySummariesWorkflow,
  });
export const getProductInventoryEntriesForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.inventoryEntriesByIds.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.inventoryEntriesByIds",
    type: "query",
    schemas: productWorkflowSchemas.inventoryEntriesByIds,
    workflow: getProductInventoryEntriesWorkflow,
  });
export const quickCreateProductForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.quickCreate.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.quickCreate",
    type: "mutation",
    schemas: productWorkflowSchemas.quickCreate,
    workflow: quickCreateProductWorkflow,
  });
export const applyProductUpcDataForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.applyUpcData.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.applyUpcData",
    type: "mutation",
    schemas: productWorkflowSchemas.applyUpcData,
    workflow: applyProductUpcDataWorkflow,
  });
export const findOrCreateProductByUpcForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.findOrCreateByUPC.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.findOrCreateByUPC",
    type: "mutation",
    schemas: productWorkflowSchemas.findOrCreateByUPC,
    workflow: findOrCreateProductByUpcWorkflow,
  });
export const findOrCreateProductByCodeForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.findOrCreateByCode.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.findOrCreateByCode",
    type: "mutation",
    schemas: productWorkflowSchemas.findOrCreateByCode,
    workflow: findOrCreateProductByCodeWorkflow,
  });
export const getProductTagOptionsForBrowser = (o: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.tagOptions",
    type: "query",
    schemas: productWorkflowSchemas.tagOptions,
    workflow: getProductTagOptionsWorkflow,
  });
export const getProductCategoryDistributionForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "product.categoryDistribution",
    type: "query",
    schemas: productWorkflowSchemas.categoryDistribution,
    workflow: getProductCategoryDistributionWorkflow,
  });
export const getProductManufacturerOptionsForBrowser = (o: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.manufacturerOptions",
    type: "query",
    schemas: productWorkflowSchemas.manufacturerOptions,
    workflow: getProductManufacturerOptionsWorkflow,
  });
export const getProductExternalIdSourceOptionsForBrowser = (o: {
  data: undefined;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.externalIdSourceOptions",
    type: "query",
    schemas: productWorkflowSchemas.externalIdSourceOptions,
    workflow: getProductExternalIdSourceOptionsWorkflow,
  });
export const getProductMovementTimelineForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.movementTimeline.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.movementTimeline",
    type: "query",
    schemas: productWorkflowSchemas.movementTimeline,
    workflow: getProductMovementTimelineWorkflow,
  });
export const getProductsByShortcodesForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.getByShortcodes.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.getByShortcodes",
    type: "query",
    schemas: productWorkflowSchemas.getByShortcodes,
    workflow: getProductsByShortcodesWorkflow,
  });
export const mergeProductsForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.merge.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.merge",
    type: "mutation",
    schemas: productWorkflowSchemas.merge,
    workflow: mergeProductsWorkflow,
  });
export const listProductProjectUsesForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.projectUses.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.projectUses",
    type: "query",
    schemas: productWorkflowSchemas.projectUses,
    workflow: listProductProjectUsesWorkflow,
  });
export const listProductPurchasesForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.purchases.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.purchases",
    type: "query",
    schemas: productWorkflowSchemas.purchases,
    workflow: listProductPurchasesWorkflow,
  });
export const listProductComponentsForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.components.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.components",
    type: "query",
    schemas: productWorkflowSchemas.components,
    workflow: listProductComponentsWorkflow,
  });
export const listKitComponentRowsForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.kitComponentRows.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.kitComponentRows",
    type: "query",
    schemas: productWorkflowSchemas.kitComponentRows,
    workflow: listKitComponentRowsWorkflow,
  });
export const listKitMembershipForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.kitMembership.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.kitMembership",
    type: "query",
    schemas: productWorkflowSchemas.kitMembership,
    workflow: listKitMembershipWorkflow,
  });
export const attachProductComponentsForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.attachComponents.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.attachComponents",
    type: "mutation",
    schemas: productWorkflowSchemas.attachComponents,
    workflow: attachProductComponentsWorkflow,
  });
export const detachProductComponentsForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.detachComponents.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.detachComponents",
    type: "mutation",
    schemas: productWorkflowSchemas.detachComponents,
    workflow: detachProductComponentsWorkflow,
  });
export const setProductProjectUsesForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.setProjectUses.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.setProjectUses",
    type: "mutation",
    schemas: productWorkflowSchemas.setProjectUses,
    workflow: setProductProjectUsesWorkflow,
  });
export const discardProductForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.discard.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.discard",
    type: "mutation",
    schemas: productWorkflowSchemas.discard,
    workflow: discardProductWorkflow,
  });
export const bulkSetProductStockTrackedForBrowser = (o: {
  data: z.input<typeof productWorkflowSchemas.bulkSetStockTracked.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "product.bulkSetStockTracked",
    type: "mutation",
    schemas: productWorkflowSchemas.bulkSetStockTracked,
    workflow: bulkSetProductStockTrackedWorkflow,
  });
