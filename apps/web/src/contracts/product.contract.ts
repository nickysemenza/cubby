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

import {
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

export const productContract = defineContract("product", {
  search: query({ ...productWorkflowSchemas.search }),
  summaries: query({ ...productWorkflowSchemas.summaries }),
  quantitySummaries: query({ ...productWorkflowSchemas.quantitySummaries }),
  inventoryEntriesByIds: query({
    ...productWorkflowSchemas.inventoryEntriesByIds,
  }),
  quickCreate: mutation({ ...productWorkflowSchemas.quickCreate }),
  applyUpcData: mutation({ ...productWorkflowSchemas.applyUpcData }),
  findOrCreateByUPC: mutation({ ...productWorkflowSchemas.findOrCreateByUPC }),
  findOrCreateByCode: mutation({
    ...productWorkflowSchemas.findOrCreateByCode,
  }),
  tagOptions: query({ ...productWorkflowSchemas.tagOptions }),
  categoryDistribution: query({
    ...productWorkflowSchemas.categoryDistribution,
  }),
  manufacturerOptions: query({
    ...productWorkflowSchemas.manufacturerOptions,
  }),
  externalIdSourceOptions: query({
    ...productWorkflowSchemas.externalIdSourceOptions,
  }),
  movementTimeline: query({ ...productWorkflowSchemas.movementTimeline }),
  getByShortcodes: query({ ...productWorkflowSchemas.getByShortcodes }),
  merge: mutation({ ...productWorkflowSchemas.merge }),
  projectUses: query({ ...productWorkflowSchemas.projectUses }),
  purchases: query({ ...productWorkflowSchemas.purchases }),
  components: query({ ...productWorkflowSchemas.components }),
  kitComponentRows: query({ ...productWorkflowSchemas.kitComponentRows }),
  kitMembership: query({ ...productWorkflowSchemas.kitMembership }),
  attachComponents: mutation({ ...productWorkflowSchemas.attachComponents }),
  detachComponents: mutation({ ...productWorkflowSchemas.detachComponents }),
  setProjectUses: mutation({ ...productWorkflowSchemas.setProjectUses }),
  discard: mutation({ ...productWorkflowSchemas.discard }),
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
