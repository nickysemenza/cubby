import {
  mcpProductCreateInput,
  mcpProductUpdateInput,
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
  registerEntityCrudToolset,
  registerMcpTool,
  resolvePublicId,
  respond,
  slimProduct,
  toUnitMappingInput,
  WRITE_CLOSED,
} from "./_shared";

/**
 * `mcpProductCreateInput`/`mcpProductUpdateInput` are MCP-only but live in
 * packages/schemas — `ingredientId` is a branded uuid there, so the shortcode
 * swap happens in these local `.extend()`s instead of in place.
 */
const productCreateMcpInput = mcpProductCreateInput.extend({
  unitMappings: z.array(mcpUnitMappingInput).optional(),
  ingredientId: idParam("ingredient")
    .nullable()
    .describe(
      "Link this product to an ingredient (its shortcode) so recipes using that ingredient can cost from this product.",
    ),
}).shape;

const productUpdateMcpShape = {
  ...mcpProductUpdateInput.shape,
  ingredientId: idParam("ingredient").nullable().optional(),
};

export function registerProductTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "product",
    names: { list: "search_products" },
    createInput: productCreateMcpInput,
    updateShape: productUpdateMcpShape,
    filterFields: productFilterFields,
    mcpListOut: productMcpListOut,
    out: productMcpOut,
    slim: slimProduct,
    sort: { orderBy: "name" },
    descriptions: {
      list: "Search products by name, manufacturer, UPC, model, or category.",
      get: "Get a product by ID.",
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
        const result = await caller.product.quickCreate({
          name: params.name,
          manufacturer: params.manufacturer,
          upc: params.upc,
          price: params.price,
        });
        return respond(result, slimProduct);
      }
      const ingredientId =
        params.ingredientId == null
          ? null
          : await resolvePublicId(
              caller,
              "ingredient",
              params.ingredientId as string,
            );
      const result = await caller.product.create({
        name: params.name,
        manufacturer: params.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: (params.upc as string | undefined) ?? null,
        fdc_id: null,
        expectedQuantity: null,
        ingredientId,
        price: (params.price as number | undefined) ?? null,
        unitMappings,
      });
      return result;
    },
    resolveUpdateData: async (caller, data) => {
      if (data.ingredientId === undefined || data.ingredientId === null) {
        return data;
      }
      return {
        ...data,
        ingredientId: await resolvePublicId(
          caller,
          "ingredient",
          data.ingredientId as string,
        ),
      };
    },
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
        id: await resolvePublicId(caller, "product", params.id),
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
