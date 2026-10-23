import { productShortcode } from "@cubby/schemas/identifiers";
import {
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

export const productContract = defineContract(
  "product",
  {
    createWithInventory: mutation({
      note: "entity.commands creates the Product and its Inventory; image.attach_file adds the photo",
      input: productCreateWithInventoryInput,
      output: productCreateWithInventoryOut,
      invalidates: ["product", "inventory"],
    }),
    search: query({
      note: "entity_read.search on products",
      ...productWorkflowSchemas.search,
    }),
    resolveNames: query({
      note: "entity_read.resolve with entity product, which never creates",
      ...productWorkflowSchemas.resolveNames,
      cache: { tags: [] },
    }),
    summaries: query({
      note: "entity_read.get per id, or entity_read.list with an ids filter on products",
      ...productWorkflowSchemas.summaries,
      cache: { profile: "derived-summary" },
    }),
    quantitySummaries: query({
      ...productWorkflowSchemas.quantitySummaries,
    }),
    inventoryEntriesByIds: query({
      note: "entity_read.get per id, or entity_read.list with an ids filter on inventory",
      ...productWorkflowSchemas.inventoryEntriesByIds,
    }),
    quickCreate: mutation({
      note: "entity.create on a product",
      ...productWorkflowSchemas.quickCreate,
      invalidates: ["product"],
    }),
    applyUpcData: mutation({
      note: "entity.update with fields read from product_enrichment_read.lookup_upc",
      ...productWorkflowSchemas.applyUpcData,
      invalidates: ["productRecipe"],
    }),
    findOrCreateByUPC: mutation({
      exposure: "capability",
      description:
        "Find or create a product by UPC barcode: the local DB, then USDA, then the UPC lookup service. This WRITES — it mints a Product when nothing matches, named by whatever the lookup returned. To only ask what a barcode names, use product_enrichment_read.lookup_upc.",
      ...productWorkflowSchemas.findOrCreateByUPC,
      invalidates: ["productLookup"],
    }),
    findOrCreateByCode: mutation({
      exposure: "capability",
      note: "product_enrichment.find_or_create_by_upc covers UPCs only, not ISBNs",
      description:
        "Resolve an ISBN or another declared Product code and create a Product only when no matching identity exists. Read the match result before adding price or inventory.",
      ...productWorkflowSchemas.findOrCreateByCode,
      invalidates: ["productLookup"],
    }),
    categoryDistribution: query({
      ...productWorkflowSchemas.categoryDistribution,
    }),
    externalIdSourceOptions: query({
      ...productWorkflowSchemas.externalIdSourceOptions,
    }),
    getByShortcodes: query({
      note: "entity_read.get per id, or entity_read.list with an ids filter on products",
      ...productWorkflowSchemas.getByShortcodes,
    }),
    /** Which field wins, and what blocks, before a two-product merge commits. */
    mergePreview: query({
      exposure: "capability",
      note: "Keeper and incoming field winners and blockers; entity_graph_read.connections reports only edge dispositions",
      description:
        "Preview Product merge winners, conflicts, and blockers for the selected keeper and incoming Product. This is read-only; review it before entity.merge.",
      input: mergeProductMatchInput.pick({ keepId: true, mergeId: true }),
      output: productMergePreview,
      cache: { tags: [] },
    }),
    projectUses: query({
      exposure: "capability",
      description:
        "Every exact project on which a reusable tool or software Product is explicitly recorded as used. Tool rows include purchase/use economics; software rows include non-additive spend charged during each project's effective window.",
      ...productWorkflowSchemas.projectUses,
      cache: {
        tags: [
          ["product", "projectUses"],
          ["project", "resource"],
        ],
      },
    }),
    components: query({
      note: "Agents read components through entity_graph_read.relation",
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
      note: "entity.link and entity.unlink on project resources",
      ...productWorkflowSchemas.setProjectUses,
      invalidates: ["projectResource"],
    }),
    discard: mutation({
      exposure: "capability",
      description:
        "Soft-delete a Product that the member has decided to discard. It does not merge duplicate identity; use merge_preview first when another Product may represent the same item.",
      destructive: true,
      command: {
        label: "Discard product",
        confirmation: null,
        affectedEntities: ["product", "inventory", "expense"],
        resultFields: [{ label: "Stored quantity", path: "storedQuantity" }],
      },
      ...productWorkflowSchemas.discard,
      invalidates: ["expense"],
    }),
    /** The proposed amount and warnings for stocking one product, before the write. */
    addToInventoryPreview: query({
      ...productWorkflowSchemas.addToInventoryPreview,
      cache: { tags: [["product"], ["inventory"]] },
    }),
    /** Which shelf a discard touches and what it will warn about, before it commits. */
    discardPreview: query({
      ...productWorkflowSchemas.discardPreview,
      cache: { tags: [["product"], ["inventory"]] },
    }),
    // Agent-facing (MCP `product_enrichment`, `product_enrichment_read`).
    /** What a barcode names in every source at once, creating nothing. */
    lookupUpc: query({
      exposure: "capability",
      description:
        "Resolve a UPC barcode to an identity WITHOUT creating anything: the Product already claiming the barcode, the USDA branded-food match, and the UPC lookup service's record, all at once. Use it whenever the question is what a barcode names — verifying a scan, confirming a product page describes the item you hold, or telling a bare tool from the kit it ships in. A barcode identifies the PACKAGE, so a kit and its bare-tool variant carry different UPCs; a brandName page reached by guessing a URL from a barcode is not evidence. Prefer this over product_enrichment.find_or_create_by_upc unless you intend to create a Product.",
      openWorld: true,
      input: z.object({ upc }),
      output: productLookupUpcOut,
      cache: { tags: [] },
    }),
    externalIdCollisions: query({
      exposure: "capability",
      description:
        "Who owns each exact (source, kind, externalId) Product identifier, in request order, including missing slots. An identifier has at most one live owner. Pass productId — the product you are about to write these onto — and `unique` splits into `owned_by_this` and `owned_by_other`; without it, `unique` only means the id has ONE live owner, which reads as a clean pass even when that owner is a different product.",
      input: productExternalIdCollisionInput,
      output: productExternalIdCollisionsOut,
    }),
    /** Fetch every attached file from R2 and record its integrity state. */
    verifyImages: mutation({
      exposure: "capability",
      description:
        'For up to 20 products (`items: [{id:"PRD-2ABC"}]`, not {ids}) in request order, fetch every attached Product file from R2, backfill legacy integrity metadata, and record available, missing, or metadata-mismatch state; each result is the refreshed detailed Product. Ordinary entity_read.get(product) makes no R2 requests.',
      input: z.object({ id: productShortcode }),
      output: productWithFoodOut,
      invalidates: ["product"],
    }),
  },
  { exposure: "view", mcpToolGroup: "product_enrichment" },
);

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
