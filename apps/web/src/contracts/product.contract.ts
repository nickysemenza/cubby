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
    mcp: {
      omit: "kernel_alternative",
      kernel: ["commands"],
      note: "entity.commands creates the Product and its Inventory; image.attach_files adds the photo",
    },
    native:
      "Create a Product and staged photo with explicit Inventory placement atomically",
    input: productCreateWithInventoryInput,
    output: productCreateWithInventoryOut,
    invalidates: ["product", "inventory"],
  }),
  search: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["search"],
      note: "entity_read.search on products",
    },
    ...productWorkflowSchemas.search,
  }),
  resolveNames: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["resolve"],
      note: "entity_read.resolve with entity product, which never creates",
    },
    ...productWorkflowSchemas.resolveNames,
    cache: { tags: [] },
  }),
  summaries: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get", "list"],
      note: "entity_read.get per id, or entity_read.list with an ids filter on products",
    },
    ...productWorkflowSchemas.summaries,
    cache: { profile: "derived-summary" },
  }),
  quantitySummaries: query({
    mcp: { omit: "client_view" },
    ...productWorkflowSchemas.quantitySummaries,
  }),
  inventoryEntriesByIds: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get", "list"],
      note: "entity_read.get per id, or entity_read.list with an ids filter on inventory",
    },
    ...productWorkflowSchemas.inventoryEntriesByIds,
  }),
  quickCreate: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["create"],
      note: "entity.create on a product",
    },
    ...productWorkflowSchemas.quickCreate,
    invalidates: ["product"],
  }),
  applyUpcData: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["update"],
      note: "entity.update with fields read from imports_read.upc_lookup",
    },
    ...productWorkflowSchemas.applyUpcData,
    invalidates: ["productRecipe"],
  }),
  findOrCreateByUPC: mutation({
    native: "Capture unknown barcode",
    ...productWorkflowSchemas.findOrCreateByUPC,
    invalidates: ["productLookup"],
  }),
  findOrCreateByCode: mutation({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
      note: "upc.find_or_create covers UPCs only, not ISBNs",
    },
    native: "Search tab create from a barcode or ISBN",
    ...productWorkflowSchemas.findOrCreateByCode,
    invalidates: ["productLookup"],
  }),
  categoryDistribution: query({
    mcp: { omit: "client_view" },
    ...productWorkflowSchemas.categoryDistribution,
  }),
  manufacturerOptions: query({
    mcp: { omit: "client_view" },
    ...productWorkflowSchemas.manufacturerOptions,
  }),
  externalIdSourceOptions: query({
    mcp: { omit: "client_view" },
    ...productWorkflowSchemas.externalIdSourceOptions,
  }),
  getByShortcodes: query({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["get", "list"],
      note: "entity_read.get per id, or entity_read.list with an ids filter on products",
    },
    ...productWorkflowSchemas.getByShortcodes,
  }),
  /** Which field wins, and what blocks, before a two-product merge commits. */
  mergePreview: query({
    mcp: {
      omit: "agent_twin",
      twin: "entity.connections",
      note: "entity_read.connections with operation merge previews the dispositions; the field-winner preview is the merge dialog's",
    },
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
    mcp: {
      omit: "client_view",
      note: "Agents read purchase products through entity_read.relations",
    },
    native: "Show related Purchase movement evidence for a Product",
    ...productWorkflowSchemas.purchases,
  }),
  components: query({
    mcp: {
      omit: "client_view",
      note: "Agents read components through entity_read.relations",
    },
    ...productWorkflowSchemas.components,
    cache: {
      tags: [
        ["product", "components"],
        ["product", "component"],
      ],
    },
  }),
  kitComponentRows: query({
    mcp: { omit: "client_view" },
    ...productWorkflowSchemas.kitComponentRows,
    cache: {
      tags: [
        ["product", "kitComponentRows"],
        ["product", "component"],
      ],
    },
  }),
  kitMembership: query({
    mcp: { omit: "client_view" },
    ...productWorkflowSchemas.kitMembership,
    cache: {
      tags: [
        ["product", "kitMembership"],
        ["product", "component"],
      ],
    },
  }),
  setProjectUses: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["link", "unlink"],
      note: "entity.link and entity.unlink on project resources",
    },
    ...productWorkflowSchemas.setProjectUses,
    invalidates: ["projectResource"],
  }),
  discard: mutation({
    mcp: {
      omit: "deferred_capability",
      todo: "Deferred MCP agent capabilities",
    },
    native: "Discard product units from the hero action",
    ...productWorkflowSchemas.discard,
    invalidates: ["expense"],
  }),
  /** The proposed amount and warnings for stocking one product, before the write. */
  addToInventoryPreview: query({
    mcp: { omit: "client_view" },
    native: "Add to inventory preview for the hero action",
    ...productWorkflowSchemas.addToInventoryPreview,
    cache: { tags: [["product"], ["inventory"]] },
  }),
  /** Which shelf a discard touches and what it will warn about, before it commits. */
  discardPreview: query({
    mcp: { omit: "client_view" },
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
