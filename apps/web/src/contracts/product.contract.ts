import { productShortcode } from "@cubby/schemas/identifiers";
import {
  patchProductExternalIdsInput,
  productCreateManyInput,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productLookupUpcOut,
  productMarkUsdaUnavailableManyInput,
  productWithFoodOut,
} from "@cubby/schemas/product";
import {
  productCreateWithInventoryInput,
  productCreateWithInventoryOut,
} from "@cubby/schemas/product-capture";
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
import { upc } from "@cubby/shared/upc";
import { z } from "zod";

import {
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

export const productContract = defineContract("product", {
  createWithInventory: mutation({
    native:
      "Create a Product and staged photo with explicit Inventory placement atomically",
    input: productCreateWithInventoryInput,
    output: productCreateWithInventoryOut,
    invalidates: ["product", "inventory"],
  }),
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
    cache: {
      tags: [
        ["product", "projectUses"],
        ["project", "resource"],
      ],
    },
  }),
  purchases: query({
    native: "Show related Purchase movement evidence for a Product",
    ...productWorkflowSchemas.purchases,
  }),
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
    native: "Discard product units from the hero action",
    ...productWorkflowSchemas.discard,
    invalidates: ["expense"],
  }),
  /** The proposed amount and warnings for stocking one product, before the write. */
  addToInventoryPreview: query({
    native: "Add to inventory preview for the hero action",
    ...productWorkflowSchemas.addToInventoryPreview,
    cache: { tags: [["product"], ["inventory"]] },
  }),
  /** Which shelf a discard touches and what it will warn about, before it commits. */
  discardPreview: query({
    native: "Discard preview for the hero action confirmation",
    ...productWorkflowSchemas.discardPreview,
    cache: { tags: [["product"], ["inventory"]] },
  }),
  // Agent-facing (MCP `imports_read`, `product_enrichment`): off the HTTP API.
  /** What a barcode names in every source at once, creating nothing. */
  lookupUpc: query({
    http: false,
    input: z.object({ upc }),
    output: productLookupUpcOut,
    cache: { tags: [] },
  }),
  externalIdCollisions: query({
    http: false,
    input: productExternalIdCollisionInput,
    output: productExternalIdCollisionsOut,
  }),
  /** One product's slot-addressed identifier patch (MCP batches it). */
  patchExternalIds: mutation({
    http: false,
    input: patchProductExternalIdsInput,
    output: productWithFoodOut,
    invalidates: ["product"],
  }),
  /** Fetch every attached file from R2 and record its integrity state. */
  verifyImages: mutation({
    http: false,
    input: z.object({ id: productShortcode }),
    output: productWithFoodOut,
    invalidates: ["product"],
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
