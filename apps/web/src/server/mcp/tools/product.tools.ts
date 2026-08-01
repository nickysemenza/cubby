import {
  mcpProductCreateInput,
  mcpProductUpdateInput,
  productExternalIdCollisionsOut,
  productFilterFields,
  productMcpListOut,
  productMcpOut,
} from "@cubby/schemas/product";
import { mcpUnitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
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
  toUnitMappingInput,
  WRITE_CLOSED,
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
    slim: slimProduct,
    sort: { orderBy: "name" },
    descriptions: {
      list: "Search products by name, manufacturer, UPC, model, category, or computed completeness. Start a product audit with dataStatus=needs_data and optionally dataGap. modelPresenceFilter and externalIdSource/externalIdPresenceFilter expose identity worklists such as Amazon-linked products lacking an Amazon external id. For the stocked product-enrichment worklist, pass inventoryPresenceFilter=has and imagePresenceFilter=none.",
      get: "Get a product by ID, including manufacturer model, notes, external identifiers, displayable-image count and cover URL, and computed dataQuality.",
      create:
        'Create a new product. Use for items not found via search_products. Pass ingredientId to link it to an ingredient and/or unitMappings (e.g. "8 oz = $10") so recipes can cost it; useful for specialty items with no USDA match.',
      update:
        "Update a product's fields. To set fdc_id, get the id from find_usda_food/search_usda_foods first. externalIds replaces the full set when provided.",
      delete:
        "Soft-delete products by IDs. Fails while live inventory entries, expenses, or tasks still reference a product.",
    },
    create: async (caller, params) => {
      const unitMappings = (
        (params.unitMappings as Array<z.infer<typeof mcpUnitMappingInput>>) ??
        []
      ).map(toUnitMappingInput);
      if (params.ingredientId == null && unitMappings.length === 0) {
        // Return the RAW row: `registerEntityCreateTool` slims every create
        // result itself, so slimming here too ran `slimProduct` over its own
        // output and would drop fields needed by the registered projection.
        return await caller.product.quickCreate({
          name: params.name,
          manufacturer: params.manufacturer,
          upc: params.upc,
          price: params.price,
        });
      }
      const result = await caller.product.create({
        name: params.name,
        manufacturer: params.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: (params.upc as string | undefined) ?? null,
        fdc_id: null,
        expectedQuantity: null,
        ingredientId: params.ingredientId,
        price: (params.price as number | undefined) ?? null,
        unitMappings,
      });
      return result;
    },
  });

  registerMcpTool(server, {
    name: "find_product_external_id_collisions",
    description:
      "Advisory exact-collision query for live Products sharing the same (source, externalId). This does not write or enforce uniqueness; inspect each collision before deciding whether it is a duplicate or a legitimate shared identifier.",
    inputSchema: {
      source: z
        .union([z.string().min(1), z.array(z.string().min(1))])
        .optional(),
    },
    outputSchema: productExternalIdCollisionsOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).product.externalIdCollisions(params),
  });

  registerMcpTool(server, {
    name: "update_product_unit_mappings",
    description:
      'Replace the unit mappings on a product (conversion/price edges like "8 oz = $10"). Pass the COMPLETE desired set; existing mappings not in the list are removed. Money unit is "dollar"; nutrient edges (b unit "kcal", "g protein") also work.',
    inputSchema: {
      id: idParam("product"),
      unitMappings: z
        .array(mcpUnitMappingInput)
        .describe(
          'The complete set of mappings to keep, e.g. [{ a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }]. An empty array clears all mappings.',
        ),
    },
    outputSchema: productMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const unitMappings = (
        params.unitMappings as Array<z.infer<typeof mcpUnitMappingInput>>
      ).map(toUnitMappingInput);
      const result = await caller.product.update({
        id: params.id,
        data: { unitMappings },
      });
      return respond(result, slimProduct);
    },
  });

  registerMcpTool(server, {
    name: "find_product_by_upc",
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
