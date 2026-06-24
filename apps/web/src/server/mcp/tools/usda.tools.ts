import { mcpPaginationParams } from "@cubby/schemas/pagination";
import { dataTypeEnum, fdcId, ndb, upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCaller,
  json,
  jsonError,
  slimUsdaFood,
  withErrorHandling,
} from "./_shared";

export function registerUsdaTools(server: McpServer) {
  server.tool(
    "search_usda_foods",
    "Search USDA FoodData Central by name (full-text). foundation_food & sr_legacy_food are generic whole foods; branded_food is specific products. Use to find a food's FDC id / UPC / NDB for nutrition or for linking a product.",
    {
      query: z.string().describe("Food name to search for"),
      dataType: dataTypeEnum
        .optional()
        .describe("Optional bias toward a USDA data type"),
      ...mcpPaginationParams,
      // Smaller default than the shared param: USDA rows carry nutrient data, so
      // fewer-per-page keeps payloads light. Override the description to match.
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Items per page (default 25, max 100)"),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.usda.list({
        filters: {
          nameFilter: params.query,
          dataTypeFilter: params.dataType,
        },
        sort: { orderBy: "description", direction: "asc" },
        pagination: {
          pageIndex: (params.pageIndex as number) ?? 0,
          pageSize: (params.pageSize as number) ?? 25,
        },
      });
      return json({
        meta: result.meta,
        items: (result.items as Record<string, unknown>[]).map(slimUsdaFood),
      });
    }),
  );

  server.tool(
    "get_usda_food",
    "Get a USDA food by its FDC id (from search_usda_foods), including compact nutrients-per-100g and any linked Cubby products.",
    { fdcId },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.usda.getByID({ id: params.fdcId });
      return json(
        result ? slimUsdaFood(result as Record<string, unknown>) : null,
      );
    }),
  );

  server.tool(
    "find_usda_food",
    "Look up a USDA food by barcode (UPC/GTIN, 12-14 digits) or NDB number. Provide exactly one.",
    {
      upc: upc.optional(),
      ndbNumber: ndb.optional(),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      const upcParam = params.upc as string | undefined;
      const ndbNumber = params.ndbNumber as number | undefined;
      if ((upcParam == null) === (ndbNumber == null)) {
        return jsonError("Provide exactly one of `upc` or `ndbNumber`.");
      }
      const lookup =
        upcParam != null
          ? ({ kind: "upc", gtin_upc: upcParam } as const)
          : ({ kind: "ndb", ndb_number: ndbNumber as number } as const);
      const result = await caller.usda.getByAlternateID(lookup);
      return json(
        result ? slimUsdaFood(result as Record<string, unknown>) : null,
      );
    }),
  );
}
