import {
  productCreateManyInput,
  productMarkUsdaUnavailableManyInput,
} from "@cubby/schemas/product";
import {
  productBackfillUpcImagesEvent,
  productCreateManyEvent,
  productMarkUsdaUnavailableEvent,
  productWorkflowSchemas,
} from "@cubby/schemas/product-workflow";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
  subscription,
} from "~/integrations/tanstack-query/operation-catalog";

export const product = defineOperationDomain("product", {
  search: query({
    ...productWorkflowSchemas.search,
    tags: [["product", "search"]],
  }),
  summaries: query({
    ...productWorkflowSchemas.summaries,
    tags: [["product", "summaries"]],
  }),
  quantitySummaries: query({
    ...productWorkflowSchemas.quantitySummaries,
    tags: [["product", "quantitySummaries"]],
  }),
  inventoryEntriesByIds: query({
    ...productWorkflowSchemas.inventoryEntriesByIds,
    tags: [["product", "inventoryEntriesByIds"]],
  }),
  quickCreate: mutation({
    ...productWorkflowSchemas.quickCreate,
    invalidates: ripple.product,
  }),
  applyUpcData: mutation({
    ...productWorkflowSchemas.applyUpcData,
    invalidates: ripple.productRecipe,
  }),
  findOrCreateByUPC: mutation({
    ...productWorkflowSchemas.findOrCreateByUPC,
    invalidates: ripple.productLookup,
  }),
  findOrCreateByCode: mutation({
    ...productWorkflowSchemas.findOrCreateByCode,
    invalidates: ripple.productLookup,
  }),
  tagOptions: query({
    ...productWorkflowSchemas.tagOptions,
    tags: [["product", "tagOptions"]],
  }),
  categoryDistribution: query({
    ...productWorkflowSchemas.categoryDistribution,
    tags: [["product", "categoryDistribution"]],
  }),
  manufacturerOptions: query({
    ...productWorkflowSchemas.manufacturerOptions,
    tags: [["product", "manufacturerOptions"]],
  }),
  externalIdSourceOptions: query({
    ...productWorkflowSchemas.externalIdSourceOptions,
    tags: [["product", "externalIdSourceOptions"]],
  }),
  movementTimeline: query({
    ...productWorkflowSchemas.movementTimeline,
    tags: [["product", "movementTimeline"]],
  }),
  getByShortcodes: query({
    ...productWorkflowSchemas.getByShortcodes,
    tags: [["product", "getByShortcodes"]],
  }),
  merge: mutation({
    ...productWorkflowSchemas.merge,
    invalidates: ripple.productMerge,
  }),
  projectUses: query({
    ...productWorkflowSchemas.projectUses,
    tags: [
      ["product", "projectUses"],
      ["project", "resource"],
    ],
  }),
  purchases: query({
    ...productWorkflowSchemas.purchases,
    tags: [["product", "purchases"]],
  }),
  relationshipRoute: query({
    ...productWorkflowSchemas.relationshipRoute,
    tags: [
      ["product", "relationshipRoute"],
      ["inventory"],
      ["location"],
      ["expense"],
      ["purchase"],
      ["project", "resource"],
      ["task"],
      ["vendor"],
    ],
  }),
  components: query({
    ...productWorkflowSchemas.components,
    tags: [
      ["product", "components"],
      ["product", "component"],
    ],
  }),
  kitComponentRows: query({
    ...productWorkflowSchemas.kitComponentRows,
    tags: [
      ["product", "kitComponentRows"],
      ["product", "component"],
    ],
  }),
  kitMembership: query({
    ...productWorkflowSchemas.kitMembership,
    tags: [
      ["product", "kitMembership"],
      ["product", "component"],
    ],
  }),
  attachComponents: mutation({
    ...productWorkflowSchemas.attachComponents,
    invalidates: ripple.productComponent,
  }),
  detachComponents: mutation({
    ...productWorkflowSchemas.detachComponents,
    invalidates: ripple.productComponent,
  }),
  setProjectUses: mutation({
    ...productWorkflowSchemas.setProjectUses,
    invalidates: ripple.projectResource,
  }),
  discard: mutation({
    ...productWorkflowSchemas.discard,
    invalidates: ripple.expense,
  }),
});

export const productStreams = defineOperationDomain("product", {
  createMany: subscription({
    input: productCreateManyInput,
    event: productCreateManyEvent,
  }),
  markUsdaUnavailableMany: subscription({
    input: productMarkUsdaUnavailableManyInput,
    event: productMarkUsdaUnavailableEvent,
  }),
  backfillUPCImages: subscription({
    input: z.undefined(),
    event: productBackfillUpcImagesEvent,
  }),
});

export const createManyProductsStream = (
  input: z.input<typeof productCreateManyInput>,
  signal?: AbortSignal,
) => productStreams.createMany.open(input, { signal });
export const markProductsUsdaUnavailableStream = (
  input: z.input<typeof productMarkUsdaUnavailableManyInput>,
  signal?: AbortSignal,
) => productStreams.markUsdaUnavailableMany.open(input, { signal });
export const backfillProductUpcImagesStream = (signal?: AbortSignal) =>
  productStreams.backfillUPCImages.open(undefined, { signal });
