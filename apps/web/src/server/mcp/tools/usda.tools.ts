import { usdaFoodMcpListOut, usdaFoodMcpOut } from "@cubby/schemas/mcp";
import { mcpPaginationFields } from "@cubby/schemas/pagination";
import { dataTypeEnum, fdcId, ndb, upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { entityKernelContextSchema } from "~/server/entity-kernel/adapter";

import {
  getCaller,
  READ_ONLY_OPEN,
  registerMcpTool,
  slimUsdaFood,
  slimUsdaFoodListItem,
} from "./_shared";

export function registerUsdaTools(server: McpServer) {
  const usdaFoodLookupOut = z.object({ food: usdaFoodMcpOut });
  const searchUsdaFoodsInput = z.object({
    query: z.string().describe("Food name to search for"),
    dataType: dataTypeEnum
      .optional()
      .describe("Optional exact USDA data-type filter"),
    ...mcpPaginationFields({ defaultPageSize: 25, maxPageSize: 100 }),
  });
  const findUsdaFoodInput = z
    .object({
      upc: upc.optional(),
      ndbNumber: ndb.optional(),
    })
    .refine(
      (input) => (input.upc === undefined) !== (input.ndbNumber === undefined),
      {
        message: "Provide exactly one of `upc` or `ndbNumber`.",
      },
    );
  registerMcpTool(server, {
    name: "search_usda_foods",
    description:
      "Use this when the user needs to choose among USDA FoodData Central records for Product nutrition mapping. The interactive picker shows the search, source type, macros, and existing Cubby links and lets the user refine before choosing. Do not invoke it when the Cubby Product already has a resolved USDA food or for a general nutrition question that does not require record selection.",
    inputSchema: searchUsdaFoodsInput,
    outputSchema: usdaFoodMcpListOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const rawContext = extra.authInfo?.extra?.entityKernel;
      const context =
        rawContext === undefined
          ? undefined
          : entityKernelContextSchema.parse(rawContext);
      if (!context?.usdaService) {
        throw new Error("MCP USDA service context is missing");
      }
      const result = await context.usdaService.listFoods(
        params.query,
        params.dataType,
        { orderBy: "relevance", direction: "asc" },
        {
          pageIndex: params.pageIndex,
          pageSize: params.pageSize,
        },
        true,
      );
      return {
        meta: {
          pageIndex: params.pageIndex,
          pageSize: params.pageSize,
          totalCount: result.count,
        },
        items: result.data.map(slimUsdaFoodListItem),
      };
    },
  });

  registerMcpTool(server, {
    name: "get_usda_food",
    description:
      "Get a USDA food by its FDC id, including compact nutrients-per-100g and any linked Cubby products.",
    inputSchema: z.object({ fdcId }),
    outputSchema: usdaFoodLookupOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const rawContext = extra.authInfo?.extra?.entityKernel;
      const context =
        rawContext === undefined
          ? undefined
          : entityKernelContextSchema.parse(rawContext);
      if (!context?.usdaService) {
        throw new Error("MCP USDA service context is missing");
      }
      const result = await context.usdaService.getFoodSummaryByID(params.fdcId);
      return { food: result ? slimUsdaFood(result) : null };
    },
  });

  registerMcpTool(server, {
    name: "find_usda_food",
    description:
      "Look up a USDA food by barcode (UPC/GTIN, 12-14 digits) or NDB number. Provide exactly one.",
    inputSchema: findUsdaFoodInput,
    outputSchema: usdaFoodLookupOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      let result;
      if (params.upc !== undefined) {
        result = await caller.usda.getByAlternateID({
          kind: "upc",
          gtin_upc: params.upc,
        });
      } else {
        if (params.ndbNumber === undefined) {
          throw new Error("Validated USDA lookup input is incomplete");
        }
        result = await caller.usda.getByAlternateID({
          kind: "ndb",
          ndb_number: params.ndbNumber,
        });
      }
      return { food: result ? slimUsdaFood(result) : null };
    },
  });
}
