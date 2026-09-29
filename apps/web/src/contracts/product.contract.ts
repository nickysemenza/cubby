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
import {
  mergeProductMatchInput,
  productMergePreview,
} from "@cubby/schemas/recommendations";
import { z } from "zod";

import {
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

export const productContract = defineContract("product", {
  search: query({ ...productWorkflowSchemas.search }),
  resolveNames: query({
    ...productWorkflowSchemas.resolveNames,
    cache: { tags: [] },
  }),
  summaries: query({
    ...productWorkflowSchemas.summaries,
    cache: { profile: "derived-summary" },
  }),
  quantitySummaries: query({ ...productWorkflowSchemas.quantitySummaries }),
  inventoryEntriesByIds: query({
    ...productWorkflowSchemas.inventoryEntriesByIds,
  }),
  quickCreate: mutation({
    ...productWorkflowSchemas.quickCreate,
    invalidates: ["product"],
  }),
  applyUpcData: mutation({
    ...productWorkflowSchemas.applyUpcData,
    invalidates: ["productRecipe"],
  }),
  findOrCreateByUPC: mutation({
    native: "Capture unknown barcode",
    ...productWorkflowSchemas.findOrCreateByUPC,
    invalidates: ["productLookup"],
  }),
  findOrCreateByCode: mutation({
    native: "Search tab create from a barcode or ISBN",
    ...productWorkflowSchemas.findOrCreateByCode,
    invalidates: ["productLookup"],
  }),
  categoryDistribution: query({
    ...productWorkflowSchemas.categoryDistribution,
  }),
  manufacturerOptions: query({
    ...productWorkflowSchemas.manufacturerOptions,
  }),
  externalIdSourceOptions: query({
    ...productWorkflowSchemas.externalIdSourceOptions,
  }),
  getByShortcodes: query({ ...productWorkflowSchemas.getByShortcodes }),
  /** Which field wins, and what blocks, before a two-product merge commits. */
  mergePreview: query({
    input: mergeProductMatchInput,
    output: productMergePreview,
    cache: { tags: [] },
  }),
  projectUses: query({
    ...productWorkflowSchemas.projectUses,
    mcp: {
      name: "list_product_project_uses",
      description:
        "Show every exact project on which a reusable Cubby tool or software Product is explicitly recorded as used. Tool rows include purchase/use economics; software rows include non-additive spend charged during each project's effective window.",
    },
    cache: {
      tags: [
        ["product", "projectUses"],
        ["project", "resource"],
      ],
    },
  }),
  purchases: query({ ...productWorkflowSchemas.purchases }),
  components: query({
    ...productWorkflowSchemas.components,
    cache: {
      tags: [
        ["product", "components"],
        ["product", "component"],
      ],
    },
  }),
  kitComponentRows: query({
    ...productWorkflowSchemas.kitComponentRows,
    cache: {
      tags: [
        ["product", "kitComponentRows"],
        ["product", "component"],
      ],
    },
  }),
  kitMembership: query({
    ...productWorkflowSchemas.kitMembership,
    cache: {
      tags: [
        ["product", "kitMembership"],
        ["product", "component"],
      ],
    },
  }),
  setProjectUses: mutation({
    ...productWorkflowSchemas.setProjectUses,
    invalidates: ["projectResource"],
  }),
  discard: mutation({
    ...productWorkflowSchemas.discard,
    invalidates: ["expense"],
  }),
});

export const productStreamsContract = defineContract("product", {
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
