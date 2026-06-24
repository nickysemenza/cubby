import { mcpPaginationParams } from "@cubby/schemas/pagination";
import {
  productCategory,
  productCreateInput,
  productUpdateData,
} from "@cubby/schemas/product";
import { mcpUnitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deleteHandler,
  getByIdHandler,
  getCaller,
  idParam,
  idsParam,
  listHandler,
  respond,
  slimProduct,
  toUnitMappingInput,
  updateHandler,
  withErrorHandling,
} from "./_shared";

export function registerProductTools(server: McpServer) {
  server.tool(
    "search_products",
    "Search products by name, manufacturer, UPC, or category.",
    {
      name: z.string().optional().describe("Filter by product name"),
      manufacturer: z.string().optional().describe("Filter by manufacturer"),
      upc: z.string().optional().describe("Filter by UPC code"),
      category: productCategory.optional().describe("Filter by category"),
      ...mcpPaginationParams,
    },
    listHandler("product", slimProduct, {
      orderBy: "name",
      buildFilters: (p) => ({
        nameFilter: p.name,
        manufacturerFilter: p.manufacturer,
        upcFilter: p.upc,
        categoryFilter: p.category,
      }),
    }),
  );

  server.tool(
    "get_product",
    "Get a product by ID.",
    { id: idParam("Product") },
    getByIdHandler("product", slimProduct),
  );

  server.tool(
    "create_product",
    'Create a new product. Use for items not found via search_products. Pass ingredientId to link it to an ingredient and/or unitMappings (e.g. "8 oz = $10") so recipes can cost it; useful for specialty items with no USDA match.',
    {
      // Field shapes + descriptions come from the canonical productCreateInput
      // (name required; the rest optional for quick entry). unitMappings uses the
      // MCP edge variant (source omittable).
      name: productCreateInput.shape.name,
      ...productCreateInput
        .pick({
          manufacturer: true,
          upc: true,
          price: true,
          expectedQuantity: true,
          ingredientId: true,
        })
        .partial().shape,
      unitMappings: z.array(mcpUnitMappingInput).optional(),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      // The quick path (name/price/upc only) preserves the original behavior.
      // Linking an ingredient or attaching mappings needs the full create input,
      // which quickCreate doesn't accept; route through product.create instead.
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
    }),
  );

  server.tool(
    "update_product",
    "Update a product's fields. To set fdc_id, get the id from find_usda_food/search_usda_foods first. externalIds replaces the full set when provided.",
    {
      id: idParam("Product"),
      // Curated subset of productUpdateData — field shapes + descriptions are
      // canonical (so forms / tRPC / MCP stay in sync). unitMappings are managed
      // by update_product_unit_mappings, not here.
      ...productUpdateData.pick({
        name: true,
        manufacturer: true,
        upc: true,
        fdc_id: true,
        usdaUnavailable: true,
        price: true,
        category: true,
        notes: true,
        externalIds: true,
      }).shape,
    },
    updateHandler("product", slimProduct),
  );

  server.tool(
    "update_product_unit_mappings",
    'Replace the unit mappings on a product (conversion/price edges like "8 oz = $10"). Pass the COMPLETE desired set; existing mappings not in the list are removed. Money unit is "dollar"; nutrient edges (b unit "kcal", "g protein") also work.',
    {
      id: idParam("Product"),
      unitMappings: z
        .array(mcpUnitMappingInput)
        .describe(
          'The complete set of mappings to keep, e.g. [{ a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }]. An empty array clears all mappings.',
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const unitMappings = (
        params.unitMappings as Array<z.infer<typeof mcpUnitMappingInput>>
      ).map(toUnitMappingInput);
      const result = await caller.product.update({
        id: params.id,
        data: { unitMappings },
      });
      return respond(result, slimProduct);
    }),
  );

  server.tool(
    "delete_products",
    "Soft-delete products by IDs. Fails if products have inventory entries.",
    { ids: idsParam("product") },
    deleteHandler("product"),
  );

  server.tool(
    "find_product_by_upc",
    "Find or create a product by UPC barcode. Checks local DB, then USDA, then UPC lookup service.",
    {
      upc,
      defaultName: z
        .string()
        .optional()
        .describe("Fallback name if not found in any database"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.product.findOrCreateByUPC({
        upc: params.upc,
        defaultName: params.defaultName,
      });
      return respond(result, slimProduct);
    }),
  );
}
