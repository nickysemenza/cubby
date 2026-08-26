import type {
  productCreateManyInput,
  productMarkUsdaUnavailableManyInput,
} from "@cubby/schemas/product";
import {
  productBackfillUpcImagesEvent,
  productCreateManyEvent,
  productMarkUsdaUnavailableEvent,
  productWorkflowSchemas,
} from "@cubby/schemas/product-workflow";
import type { z } from "zod";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";
import { openWorkflowStream } from "~/lib/workflow-stream";

export const product = defineOperationDomain("product", {
  search: query({
    ...productWorkflowSchemas.search,
    tags: [["product"], ["product", "search"]],
  }),
  summaries: query({
    ...productWorkflowSchemas.summaries,
    tags: [["product"], ["product", "summaries"]],
  }),
  quantitySummaries: query({
    ...productWorkflowSchemas.quantitySummaries,
    tags: [["product"], ["product", "quantitySummaries"]],
  }),
  inventoryEntriesByIds: query({
    ...productWorkflowSchemas.inventoryEntriesByIds,
    tags: [["product"], ["product", "inventoryEntriesByIds"]],
  }),
  quickCreate: mutation({
    ...productWorkflowSchemas.quickCreate,
    invalidates: [["product"]],
  }),
  applyUpcData: mutation({
    ...productWorkflowSchemas.applyUpcData,
    invalidates: [["product", "recipe"], ["problems"]],
  }),
  findOrCreateByUPC: mutation({
    ...productWorkflowSchemas.findOrCreateByUPC,
    invalidates: [["product", "lookup"]],
  }),
  findOrCreateByCode: mutation({
    ...productWorkflowSchemas.findOrCreateByCode,
    invalidates: [["product", "lookup"]],
  }),
  tagOptions: query({
    ...productWorkflowSchemas.tagOptions,
    tags: [["product"], ["product", "tagOptions"]],
  }),
  categoryDistribution: query({
    ...productWorkflowSchemas.categoryDistribution,
    tags: [["product"], ["product", "categoryDistribution"]],
  }),
  manufacturerOptions: query({
    ...productWorkflowSchemas.manufacturerOptions,
    tags: [["product"], ["product", "manufacturerOptions"]],
  }),
  externalIdSourceOptions: query({
    ...productWorkflowSchemas.externalIdSourceOptions,
    tags: [["product"], ["product", "externalIdSourceOptions"]],
  }),
  movementTimeline: query({
    ...productWorkflowSchemas.movementTimeline,
    tags: [["product"], ["product", "movementTimeline"]],
  }),
  getByShortcodes: query({
    ...productWorkflowSchemas.getByShortcodes,
    tags: [["product"], ["product", "getByShortcodes"]],
  }),
  merge: mutation({
    ...productWorkflowSchemas.merge,
    invalidates: [["product", "merge"]],
  }),
  projectUses: query({
    ...productWorkflowSchemas.projectUses,
    tags: [["product"], ["product", "projectUses"], ["project", "resource"]],
  }),
  purchases: query({
    ...productWorkflowSchemas.purchases,
    tags: [["product"], ["product", "purchases"]],
  }),
  components: query({
    ...productWorkflowSchemas.components,
    tags: [["product"], ["product", "components"], ["product", "component"]],
  }),
  kitComponentRows: query({
    ...productWorkflowSchemas.kitComponentRows,
    tags: [
      ["product"],
      ["product", "kitComponentRows"],
      ["product", "component"],
    ],
  }),
  kitMembership: query({
    ...productWorkflowSchemas.kitMembership,
    tags: [["product"], ["product", "kitMembership"], ["product", "component"]],
  }),
  attachComponents: mutation({
    ...productWorkflowSchemas.attachComponents,
    invalidates: [["product", "component"]],
  }),
  detachComponents: mutation({
    ...productWorkflowSchemas.detachComponents,
    invalidates: [["product", "component"]],
  }),
  setProjectUses: mutation({
    ...productWorkflowSchemas.setProjectUses,
    invalidates: [["project", "resource"]],
  }),
  discard: mutation({
    ...productWorkflowSchemas.discard,
    invalidates: [["expense"]],
  }),
  bulkSetStockTracked: mutation({
    ...productWorkflowSchemas.bulkSetStockTracked,
    invalidates: [["product"]],
  }),
});

export const createManyProductsStream = (
  input: z.input<typeof productCreateManyInput>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "product.createMany",
    kind: "mutation",
    url: "/api/product-stream/create-many",
    input,
    eventSchema: productCreateManyEvent,
    signal,
  });
export const markProductsUsdaUnavailableStream = (
  input: z.input<typeof productMarkUsdaUnavailableManyInput>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "product.markUsdaUnavailableMany",
    kind: "mutation",
    url: "/api/product-stream/mark-usda-unavailable",
    input,
    eventSchema: productMarkUsdaUnavailableEvent,
    signal,
  });
export const backfillProductUpcImagesStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "product.backfillUPCImages",
    kind: "mutation",
    url: "/api/product-stream/backfill-upc-images",
    input: undefined,
    eventSchema: productBackfillUpcImagesEvent,
    signal,
  });
