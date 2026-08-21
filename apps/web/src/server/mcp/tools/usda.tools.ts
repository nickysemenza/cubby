import { usdaFoodMcpListOut, usdaFoodMcpOut } from "@cubby/schemas/mcp";
import { mcpPaginationParams } from "@cubby/schemas/pagination";
import { dataTypeEnum, fdcId, ndb, upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { USDA_PICKER_UI } from "../apps";
import {
  getCaller,
  READ_ONLY_OPEN,
  registerMcpTool,
  slimUsdaFood,
  slimUsdaFoodListItem,
  structuredError,
} from "./_shared";

export function registerUsdaTools(server: McpServer) {
  registerMcpTool(server, {
    name: "search_usda_foods",
    description:
      "Use this when the user needs to choose among USDA FoodData Central records for Product nutrition mapping. The interactive picker shows the search, source type, macros, and existing Cubby links and lets the user refine before choosing. Do not invoke it when the Cubby Product already has a resolved USDA food or for a general nutrition question that does not require record selection.",
    inputSchema: {
      query: z.string().describe("Food name to search for"),
      dataType: dataTypeEnum
        .optional()
        .describe("Optional exact USDA data-type filter"),
      ...mcpPaginationParams,
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Items per page (default 25, max 100)"),
    },
    outputSchema: usdaFoodMcpListOut,
    annotations: READ_ONLY_OPEN,
    uiResourceUri: USDA_PICKER_UI,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.usda.list({
        filters: {
          nameFilter: params.query,
          dataTypeFilter: params.dataType,
          // Exclude the five sampling/research data types — provenance records
          // carrying ~0 nutrients, which USDA FDC itself hides from food search.
          foodsOnly: true,
        },
        // `relevance` is the ranked path: exact/whole-word/prefix description
        // fit, then full-text relevance and specificity. Data type is only a
        // late tie-break; the app explains the sources instead of treating one
        // as universally best. FDC id is a stable paging key, not a quality cue.
        sort: { orderBy: "relevance", direction: "asc" },
        pagination: {
          pageIndex: (params.pageIndex as number) ?? 0,
          pageSize: (params.pageSize as number) ?? 25,
        },
      });
      return {
        meta: result.meta,
        items: (result.items as Record<string, unknown>[]).map(
          slimUsdaFoodListItem,
        ),
      };
    },
  });

  registerMcpTool(server, {
    name: "get_usda_food",
    description:
      "Get a USDA food by its FDC id, including compact nutrients-per-100g and any linked Cubby products.",
    inputSchema: { fdcId },
    outputSchema: usdaFoodMcpOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.usda.getByID({ id: params.fdcId });
      return result ? slimUsdaFood(result as Record<string, unknown>) : null;
    },
  });

  registerMcpTool(server, {
    name: "find_usda_food",
    description:
      "Look up a USDA food by barcode (UPC/GTIN, 12-14 digits) or NDB number. Provide exactly one.",
    inputSchema: {
      upc: upc.optional(),
      ndbNumber: ndb.optional(),
    },
    outputSchema: usdaFoodMcpOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const upcParam = params.upc as string | undefined;
      const ndbNumber = params.ndbNumber as number | undefined;
      if ((upcParam == null) === (ndbNumber == null)) {
        return structuredError("Provide exactly one of `upc` or `ndbNumber`.");
      }
      const lookup =
        upcParam != null
          ? ({ kind: "upc", gtin_upc: upcParam } as const)
          : ({ kind: "ndb", ndb_number: ndbNumber as number } as const);
      const result = await caller.usda.getByAlternateID(lookup);
      return result ? slimUsdaFood(result as Record<string, unknown>) : null;
    },
  });
}
