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
  READ_ONLY_CLOSED,
  registerEntityDeleteTool,
  registerEntityGetTool,
  registerEntityListTool,
  registerEntityUpdateTool,
  registerMcpTool,
  respond,
  slimProduct,
  toUnitMappingInput,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
  withIdInput,
} from "./_shared";

const productCreateMcpInput = mcpProductCreateInput.extend({
  unitMappings: z.array(mcpUnitMappingInput).optional(),
}).shape;

export function registerProductTools(server: McpServer) {
  registerEntityListTool(server, {
    name: "search_products",
    description: "Search products by name, manufacturer, UPC, or category.",
    router: "product",
    filterFields: productFilterFields,
    outputSchema: productMcpListOut,
    slim: slimProduct,
    sort: { orderBy: "name" },
    annotations: READ_ONLY_CLOSED,
  });

  registerEntityGetTool(server, {
    name: "get_product",
    description: "Get a product by ID.",
    router: "product",
    idLabel: "Product",
    outputSchema: productMcpOut,
    slim: slimProduct,
    annotations: READ_ONLY_CLOSED,
  });

  registerMcpTool(server, {
    name: "create_product",
    description:
      'Create a new product. Use for items not found via search_products. Pass ingredientId to link it to an ingredient and/or unitMappings (e.g. "8 oz = $10") so recipes can cost it; useful for specialty items with no USDA match.',
    inputSchema: productCreateMcpInput,
    outputSchema: productMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
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
          expectedQuantity: params.expectedQuantity,
        });
        return respond(result, slimProduct);
      }
      const result = await caller.product.create({
        name: params.name,
        manufacturer: params.manufacturer ?? UNSPECIFIED_MANUFACTURER,
        upc: (params.upc as string | undefined) ?? null,
        fdc_id: null,
        expectedQuantity:
          (params.expectedQuantity as number | undefined) ?? null,
        ingredientId: (params.ingredientId as string | undefined) ?? null,
        price: (params.price as number | undefined) ?? null,
        unitMappings,
      });
      return respond(result, slimProduct);
    },
  });

  registerEntityUpdateTool(server, {
    name: "update_product",
    description:
      "Update a product's fields. To set fdc_id, get the id from find_usda_food/search_usda_foods first. externalIds replaces the full set when provided.",
    inputSchema: withIdInput("Product", mcpProductUpdateInput.shape),
    outputSchema: productMcpOut,
    slim: slimProduct,
    router: "product",
    annotations: WRITE_CLOSED,
  });

  registerMcpTool(server, {
    name: "update_product_unit_mappings",
    description:
      'Replace the unit mappings on a product (conversion/price edges like "8 oz = $10"). Pass the COMPLETE desired set; existing mappings not in the list are removed. Money unit is "dollar"; nutrient edges (b unit "kcal", "g protein") also work.',
    inputSchema: {
      id: idParam("Product"),
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

  registerEntityDeleteTool(server, {
    name: "delete_products",
    description:
      "Soft-delete products by IDs. Fails if products have inventory entries.",
    router: "product",
    entityLabel: "product",
    annotations: WRITE_DESTRUCTIVE_CLOSED,
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
