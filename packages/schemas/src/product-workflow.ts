import { z } from "zod";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  createPaginatedResponseSchemaWithContext,
  createSortPaginationFields,
} from "./pagination";
import {
  mergeProductsInput,
  productApplyUpcInput,
  productCategoryDistributionOut,
  productDiscardInput,
  productDiscardOut,
  productExternalIdSourceOptionsOut,
  productFiltersSchema,
  productFindOrCreateByCodeInput,
  productFindOrCreateByUPCInput,
  productFindOrCreateByUPCOut,
  productInventoryEntriesBatchInput,
  productInventoryEntriesByIdOut,
  productManufacturerOptionsOut,
  productMergeSummaryOut,
  productMovementTimelineInput,
  productMovementTimelineOut,
  productPickerItemOut,
  productQuantitySummariesOut,
  productQuantitySummaryBatchInput,
  productQuickCreatePayload,
  productShortcodeListOut,
  productShortcodesInput,
  productSortableFields,
  productSummariesInput,
  productSummariesOut,
  productTagOptionsOut,
  productTopLevelOut,
  productWithFoodAndSideEffectsOut,
} from "./product";
import {
  attachProductComponentsInput,
  detachProductComponentsInput,
  kitComponentRowsInput,
  kitComponentRowsOut,
  kitMembershipsInput,
  kitMembershipsOut,
  productComponentMutationOut,
  productComponentsInput,
  productComponentsOut,
} from "./product-components";
import {
  productProjectUsesInput,
  productProjectUsesOut,
  productProjectUsesSetInput,
  productProjectUsesSetOut,
} from "./project";
import { productPurchasesInput, productPurchasesOut } from "./purchase";

export const productSearchInput = z.object({
  filters: productFiltersSchema,
  ...createSortPaginationFields({
    sortableFields: productSortableFields,
    defaultSort: "name",
  }),
});

const productSearchOut = createPaginatedResponseSchemaWithContext(
  productPickerItemOut,
  "product",
);
const productMergeOut = z.object({
  product: productTopLevelOut,
  mergeSummary: productMergeSummaryOut,
});

const productCreateManyResult = z.object({
  created: z.number().int().nonnegative(),
  sideEffects: mutationSideEffectsSchema,
  failed: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      name: z.string(),
      error: z.string(),
    }),
  ),
});
export type CreateManyProductResult = z.output<typeof productCreateManyResult>;

const progressEvent = z.object({
  type: z.literal("progress"),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export const productCreateManyEvent = z.discriminatedUnion("type", [
  progressEvent,
  z.object({ type: z.literal("done"), result: productCreateManyResult }),
]);
export const productMarkUsdaUnavailableEvent = z.discriminatedUnion("type", [
  progressEvent,
  z.object({
    type: z.literal("done"),
    result: z.object({ updated: z.number().int().nonnegative() }),
  }),
]);
export const productBackfillUpcImagesEvent = z.discriminatedUnion("type", [
  progressEvent,
  z.object({
    type: z.literal("done"),
    result: z.object({
      found: z.number().int().nonnegative(),
      imported: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  }),
]);

export const productWorkflowSchemas = {
  search: { input: productSearchInput, output: productSearchOut },
  summaries: { input: productSummariesInput, output: productSummariesOut },
  quantitySummaries: {
    input: productQuantitySummaryBatchInput,
    output: productQuantitySummariesOut,
  },
  inventoryEntriesByIds: {
    input: productInventoryEntriesBatchInput,
    output: productInventoryEntriesByIdOut,
  },
  quickCreate: { input: productQuickCreatePayload, output: productTopLevelOut },
  applyUpcData: {
    input: productApplyUpcInput,
    output: productWithFoodAndSideEffectsOut,
  },
  findOrCreateByUPC: {
    input: productFindOrCreateByUPCInput,
    output: productFindOrCreateByUPCOut,
  },
  findOrCreateByCode: {
    input: productFindOrCreateByCodeInput,
    output: productFindOrCreateByUPCOut,
  },
  tagOptions: { input: z.undefined(), output: productTagOptionsOut },
  categoryDistribution: {
    input: z.undefined(),
    output: productCategoryDistributionOut,
  },
  manufacturerOptions: {
    input: z.undefined(),
    output: productManufacturerOptionsOut,
  },
  externalIdSourceOptions: {
    input: z.undefined(),
    output: productExternalIdSourceOptionsOut,
  },
  movementTimeline: {
    input: productMovementTimelineInput,
    output: productMovementTimelineOut,
  },
  getByShortcodes: {
    input: productShortcodesInput,
    output: productShortcodeListOut,
  },
  merge: { input: mergeProductsInput, output: productMergeOut },
  projectUses: {
    input: productProjectUsesInput,
    output: productProjectUsesOut,
  },
  purchases: { input: productPurchasesInput, output: productPurchasesOut },
  components: { input: productComponentsInput, output: productComponentsOut },
  kitComponentRows: {
    input: kitComponentRowsInput,
    output: kitComponentRowsOut,
  },
  kitMembership: { input: kitMembershipsInput, output: kitMembershipsOut },
  attachComponents: {
    input: attachProductComponentsInput,
    output: productComponentMutationOut,
  },
  detachComponents: {
    input: detachProductComponentsInput,
    output: productComponentMutationOut,
  },
  setProjectUses: {
    input: productProjectUsesSetInput,
    output: productProjectUsesSetOut,
  },
  discard: { input: productDiscardInput, output: productDiscardOut },
} as const;
