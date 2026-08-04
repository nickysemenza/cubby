import {
  mcpProductCreateInput,
  mcpProductUpdateInput,
  mergeProductsInput,
  mergeProductsMcpOut,
  patchProductExternalIdsInput,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productFilterFields,
  productMcpDetailOut,
  productMcpListOut,
  productMcpOut,
} from "@cubby/schemas/product";
import type { mcpUnitMappingInput } from "@cubby/schemas/unitmapping";
import { upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerMcpTool,
  respond,
  slimProduct,
  slimProductDetail,
  toUnitMappingInput,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

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
    batch: { create: true, update: true },
    create: async (caller, params) => {
      const unitMappings = (
        (params.unitMappings as Array<z.infer<typeof mcpUnitMappingInput>>) ??
        []
      ).map(toUnitMappingInput);
      return await caller.product.create({
        name: params.name,
        manufacturer: params.manufacturer,
        aliases: params.aliases ?? [],
        tags: params.tags ?? [],
        upc: (params.upc as string | null | undefined) ?? null,
        fdc_id: (params.fdc_id as number | null | undefined) ?? null,
        model: (params.model as string | null | undefined) ?? null,
        notes: (params.notes as string | null | undefined) ?? null,
        expectedQuantity:
          (params.expectedQuantity as number | null | undefined) ?? null,
        category: params.category ?? null,
        ingredientId: params.ingredientId ?? null,
        price: (params.price as number | undefined) ?? null,
        unitMappings,
        externalIds: params.externalIds ?? [],
        usdaUnavailable:
          (params.usdaUnavailable as boolean | null | undefined) ?? null,
      });
    },
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
      "Find duplicate live Product external identifiers. Use source for a broad audit, or identifiers for ordered exact (source, kind, externalId) results including missing and unique slots.",
    inputSchema: productExternalIdCollisionInput.shape,
    outputSchema: productExternalIdCollisionsOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).product.externalIdCollisions(params),
  });

  registerMcpTool(server, {
    name: "patch_product_external_ids",
    description:
      "Patch named (source, kind) identifier slots without replacing unrelated Product identifiers. Upserts overwrite only their slot; every removal must include the exact current external ID and all preconditions are checked before anything changes.",
    inputSchema: patchProductExternalIdsInput.shape,
    outputSchema: productMcpDetailOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      respond(
        await getCaller(extra).product.patchExternalIds(params),
        slimProductDetail,
      ),
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

  registerMcpTool(server, {
    name: "merge_products",
    description:
      "Fold duplicate products into one survivor. Moves the merged-away products' stock, ledger lines, identifiers, images, unit mappings, tasks, project uses, and wishlist candidacies onto keepId, then soft-deletes them. Stock in a location the survivor already stocks is SUMMED into the survivor's entry; an identifier slot (source, kind) the survivor already fills keeps the survivor's value and discards the other. Refuses when two entries in one location carry different units — preview with preview_entity_operation first.",
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
    name: "find_or_create_product_by_upc",
    description:
      "Find or create a product by UPC barcode. Checks local DB, then USDA, then UPC lookup service.",
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
}
