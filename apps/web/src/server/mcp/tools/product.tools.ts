import {
  mcpProductCreateInput,
  mcpProductUpdateInput,
  mergeProductsInput,
  mergeProductsMcpOut,
  patchProductExternalIdsInput,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productFilterFields,
  productLookupUpcOut,
  productMcpDetailOut,
  productMcpListOut,
  productMcpOut,
} from "@cubby/schemas/product";
import {
  attachProductComponentsInput,
  detachProductComponentsInput,
  productComponentMutationOut,
  productComponentsInput,
  productComponentsMcpOut,
} from "@cubby/schemas/product-components";
import type { mcpUnitMappingInput } from "@cubby/schemas/unitmapping";
import { upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerBatchTool,
  registerEntityCrudToolset,
  registerMcpTool,
  registerRouterTool,
  rejectDuplicateIds,
  respond,
  slimProduct,
  slimProductDetail,
  toUnitMappingInput,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

/**
 * `lookup_upc` over the slim product projection.
 *
 * The tRPC output carries `productTopLevelOut`, whose nested `images[].id` and
 * `externalIds[].id` are raw uuids — fine inside the app, but a uuid must never
 * reach an MCP payload. `slimProduct` is the same projection every other product
 * tool publishes, so the local match reads identically here and in
 * `search_products`.
 */
const lookupUpcMcpOut = productLookupUpcOut.extend({
  localProduct: productMcpOut.nullable(),
});

export function registerProductTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "product",
    names: { list: "search_products" },
    createInput: mcpProductCreateInput.shape,
    updateShape: mcpProductUpdateInput.shape,
    filterFields: productFilterFields,
    mcpListOut: productMcpListOut,
    out: productMcpOut,
    detailOut: productMcpDetailOut,
    detailSlim: slimProductDetail,
    slim: slimProduct,
    sort: { orderBy: "name" },
    listSortInput: z.enum(["name", "identity_strength"]).optional(),
    descriptions: {
      list: "Search products by name, manufacturer, UPC, model, category, or computed completeness. Start a product audit with dataStatus=needs_data and optionally dataGap. For enrichment use sort=identity_strength. modelPresenceFilter and externalIdSource/externalIdPresenceFilter expose identity worklists such as Amazon-linked products lacking an Amazon external id. For the stocked product-enrichment worklist, pass inventoryPresenceFilter=has and imagePresenceFilter=none.",
      get: "Get a detailed product by ID, including identifiers, coverImageId, every attached Product file with integrity metadata/display position, and computed dataQuality. This read does not contact R2; use verify_product_images for an on-demand storage check.",
      create:
        "Create a fully described product. Use for items not found via search_products; include maker model, category, tags, identifiers, and unit mappings when verified. Retailer SKUs belong in externalIds, not model.",
      update:
        "Update a product's fields, complete unit-mapping set, detached files, or cover/gallery order. externalIds replaces the full set when provided; use patch_product_external_ids to preserve unrelated identifier slots.",
      delete:
        "Soft-delete products by IDs. Fails while live inventory entries, expenses, or tasks still reference a product.",
    },
    // Spread, never enumerate. A field-by-field copy silently drops any field
    // added to `mcpProductCreateInput` later and the created row reads back as
    // if the agent never sent it — that is how `stockTracked: false` became
    // `null` on every MCP-created product, erasing the reviewed/no-shelf-claim
    // decision the create call actually made. Only fields whose MCP shape is
    // genuinely looser than the router's are normalized here.
    create: async (caller, params) =>
      await caller.product.create({
        ...params,
        // Required (nullable, not optional) on the router's create input.
        expectedQuantity: params.expectedQuantity ?? null,
        upc: params.upc ?? null,
        ingredientId: params.ingredientId ?? null,
        unitMappings: (params.unitMappings ?? []).map(toUnitMappingInput),
      }),
    resolveUpdateData: async (_caller, data) =>
      data.unitMappings === undefined
        ? data
        : {
            ...data,
            unitMappings: (
              data.unitMappings as Array<z.infer<typeof mcpUnitMappingInput>>
            ).map(toUnitMappingInput),
          },
  });

  registerMcpTool(server, {
    name: "find_product_external_id_collisions",
    description:
      "Find duplicate live Product external identifiers. Use source for a broad audit, or identifiers for ordered exact (source, kind, externalId) results including missing and unique slots. Pass productId — the product you are about to write these onto — and `unique` splits into `owned_by_this` and `owned_by_other`; without it, `unique` only means the id has ONE live owner, which reads as a clean pass even when that owner is a different product.",
    inputSchema: productExternalIdCollisionInput.shape,
    outputSchema: productExternalIdCollisionsOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).product.externalIdCollisions(params),
  });

  registerMcpTool(server, {
    name: "patch_product_external_ids",
    description:
      "Patch named (source, kind) identifier slots without replacing unrelated Product identifiers. A slot holds ONE primary plus any number of secondaries — Amazon lists one item twice, so a product legitimately carries two ASINs. An upsert replaces the primary; pass isPrimary: false to add an additional identifier alongside it, addressed by its own value. Every removal must include the exact current external ID, all preconditions are checked before anything changes, and removing a primary promotes the oldest surviving secondary so the slot always has a value standing for it.",
    inputSchema: patchProductExternalIdsInput.shape,
    outputSchema: productMcpDetailOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      respond(
        await getCaller(extra).product.patchExternalIds(params),
        slimProductDetail,
      ),
  });

  registerBatchTool(server, {
    name: "patch_products_external_ids",
    description:
      "Patch identifier slots on up to 50 products in request order. Each item uses the same validation and preconditions as patch_product_external_ids; a failed item does not roll back successful items. Use this to apply an enrichment sweep's identifier findings in one call.",
    itemInput: patchProductExternalIdsInput,
    itemOutput: productMcpDetailOut,
    annotations: WRITE_CLOSED,
    refineItems: rejectDuplicateIds,
    run: async (caller, item) =>
      respond(await caller.product.patchExternalIds(item), slimProductDetail),
  });

  registerMcpTool(server, {
    name: "verify_product_images",
    description:
      "Fetch every attached Product file from R2, backfill legacy integrity metadata, and record available, missing, or metadata-mismatch state. Returns the refreshed detailed Product; ordinary get_product performs no R2 requests.",
    inputSchema: { id: idParam("product") },
    outputSchema: productMcpDetailOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      respond(
        await getCaller(extra).product.verifyImages(params.id),
        slimProductDetail,
      ),
  });

  registerBatchTool(server, {
    name: "verify_products_images",
    description:
      "Run verify_product_images across up to 20 products in request order. Capped lower than other batches because every item makes one R2 round trip per attached file, not a single database write.",
    itemInput: z.object({ id: idParam("product") }),
    itemOutput: productMcpDetailOut,
    // Each item fans out to one R2 fetch PER attached file, so 50 products is a
    // few hundred network round trips inside one Worker invocation. Every other
    // batch here is DB-bound, which is why this is the one that departs from 50.
    maxItems: 20,
    // The refreshed image state is the entire product of this call — a compact
    // list of ids would say nothing about what verification found.
    defaultResultDetail: "full",
    annotations: WRITE_CLOSED,
    refineItems: rejectDuplicateIds,
    run: async (caller, item) =>
      respond(await caller.product.verifyImages(item.id), slimProductDetail),
  });

  registerMcpTool(server, {
    name: "merge_products",
    description:
      "Fold duplicate products into one survivor. Moves the merged-away products' stock, ledger lines, identifiers, images, unit mappings, tasks, project uses, and wishlist candidacies onto keepId, then soft-deletes them. Stock in a location the survivor already stocks is SUMMED into the survivor's entry; an identifier slot (source, kind) the survivor already fills keeps the survivor's value as PRIMARY and carries the other over as a secondary rather than destroying it (returned in mergeSummary.externalIdsDemoted). The survivor's cover image is preserved. Refuses when two entries in one location carry different units — preview with preview_entity_operation first.",
    inputSchema: mergeProductsInput.shape,
    outputSchema: mergeProductsMcpOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    handler: async (params, extra) => {
      const result = await getCaller(extra).product.merge(params);
      return {
        product: slimProduct(result.product),
        mergeSummary: result.mergeSummary,
      };
    },
  });

  registerMcpTool(server, {
    name: "lookup_upc",
    description:
      "Resolve a UPC barcode to an identity WITHOUT creating anything. Returns all three sources at once: the Product already claiming the barcode, the USDA branded-food match, and the UPC lookup service's record. Use this whenever the question is what a barcode names — verifying a scan, confirming a product page really describes the item you hold, or checking whether a barcode belongs to a bare tool or the kit it ships in. A barcode identifies the PACKAGE, so a kit and its bare-tool variant carry different UPCs; a manufacturer page reached by guessing a URL from a barcode is not evidence. Prefer this over find_or_create_product_by_upc unless you actually intend to create a Product.",
    inputSchema: { upc },
    outputSchema: lookupUpcMcpOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const result = await getCaller(extra).product.lookupUpc({
        upc: params.upc,
      });
      return {
        ...result,
        localProduct: result.localProduct
          ? respond(result.localProduct, slimProduct)
          : null,
      };
    },
  });

  registerMcpTool(server, {
    name: "find_or_create_product_by_upc",
    description:
      "Find or create a product by UPC barcode. Checks local DB, then USDA, then UPC lookup service. This WRITES — it mints a Product when nothing matches, using whatever name the lookup returned. To only ask what a barcode names, use lookup_upc instead.",
    inputSchema: {
      upc,
      defaultName: z
        .string()
        .optional()
        .describe("Fallback name if not found in any database"),
    },
    outputSchema: productMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const { product } = await caller.product.findOrCreateByUPC({
        upc: params.upc,
        defaultName: params.defaultName,
      });
      return respond(product, slimProduct);
    },
  });

  registerRouterTool(server, {
    name: "list_product_components",
    description:
      "List what's inside one kit or multi-pack Product — the ProductComponent edge. A kit Product (a combo tool kit, a multi-pack, a bundle) is a Product like any other, with its OWN UPC, model, ASIN, image, and purchase history; this is the only place that records what it's MADE OF. One row per distinct component: a 4-pack of one part is a single row at quantity 4, a 9-piece kit is nine separate rows. The kit keeps its OWN Expense — it is never split into per-component expenses. Instead each row's `price` is the component PRODUCT's effective price, which ALREADY BLENDS its own purchase history with its quantity-weighted share of every kit it belongs to (that share being the kit's cost × this quantity ÷ the kit's total component units, derived at read time). So do NOT compute a share yourself on top of this number — it is already in there, and doing so double-counts. A part that was only ever bought inside a kit still returns a real price here, from the kit. An explicit price set on the component product overrides the blend entirely. For the reverse question — every kit a Product is listed inside — read that Product's own detail page; the transpose has no separate MCP tool.",
    inputSchema: productComponentsInput.shape,
    // `{items}`, like every other list tool — the router's own array root is a
    // shape the MCP SDK rejects outright. See `productComponentsMcpOut`.
    outputSchema: productComponentsMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => ({
      items: await caller.product.components(params),
    }),
  });

  registerRouterTool(server, {
    name: "attach_product_components",
    description:
      "Record that one or more existing Products are inside a kit or multi-pack Product — the ProductComponent edge. `parentProductId` is the kit; each entry in `components` names one component Product and how many of it the kit contains (a 4-pack of one part is one entry at quantity 4, a 9-piece kit is nine entries). This creates no money and splits nothing: the kit keeps its own Expense and its own price, exactly as before attaching — use split_expense instead if the goal is a real per-component cost basis, not a composition record. A barcode/model identifies the PACKAGE: the kit keeps its OWN UPC/model/ASIN, and a component's identifiers stay its own — never copy the kit's barcode onto a component or a component's onto the kit just because they ship together. REFUSES a self-referencing entry (a Product cannot be its own component) and REFUSES any component that does not exist or is not live. Quantity is set at attach time; to change it, detach and reattach — there is no in-place update. Repeating an already-live pair is idempotent and reports nothing changed.",
    inputSchema: attachProductComponentsInput.shape,
    outputSchema: productComponentMutationOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.product.attachComponents(params),
  });

  registerRouterTool(server, {
    name: "detach_product_components",
    description:
      "Soft-delete one or more component links from one kit Product. This only removes the composition record — the kit's Expense was never split across its components, so detaching touches no money, no inventory, and no price. Idempotent: detaching a link that is already gone reports nothing changed rather than erroring.",
    inputSchema: detachProductComponentsInput.shape,
    outputSchema: productComponentMutationOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (caller, params) => caller.product.detachComponents(params),
  });
}
