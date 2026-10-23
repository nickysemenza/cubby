import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { callMcpTool } from "../testing/mcp-test-utils";
import { createMcpServer, listMcpToolCatalog } from "./server";

describe("MCP response policies", () => {
  it("publishes the same page and recipe defaults that handlers apply", async () => {
    const { tools } = await listMcpToolCatalog();
    for (const name of ["activity", "usda_food"]) {
      expect(
        tools.find((tool) => tool.name === name)?.inputSchema,
      ).toMatchObject({
        properties: {
          pageIndex: { default: 0, minimum: 0 },
          pageSize: { default: 25, minimum: 1, maximum: 100 },
        },
      });
    }
    expect(
      tools.find((tool) => tool.name === "recipe_insights")?.inputSchema,
    ).toMatchObject({ properties: { detail: { default: "lines" } } });
  });

  it.each([
    [{}, { pageIndex: 0, pageSize: 25 }],
    [
      { pageIndex: 2, pageSize: 5 },
      { pageIndex: 2, pageSize: 5 },
    ],
  ])(
    "forwards USDA pagination and preserves complete totals: %j",
    async (input, page) => {
      const listFoods = vi.fn(async () => ({ data: [], count: 123 }));
      const result = await callMcpTool(
        createMcpServer(),
        "usda_food",
        { action: "search", query: "synthetic food", ...input },
        { usdaService: fromPartial({ listFoods }) },
      );
      expect(result.isError).not.toBe(true);
      expect(listFoods).toHaveBeenCalledWith(
        "synthetic food",
        undefined,
        { orderBy: "relevance", direction: "asc" },
        page,
        true,
      );
      expect(result.structuredContent).toEqual({
        items: [],
        meta: { ...page, totalCount: 123 },
      });
    },
  );

  it("projects compact USDA search rows, which carry no nutrient summary", async () => {
    // A complete member row: the runner validates the member's own output
    // before the MCP projection slims it.
    const row = {
      fdc_id: 9900001,
      description: "Synthetic rolled oats",
      inferredUnitMappings: [],
      foodInfo: {
        data_type: "foundation_food",
        description: "Synthetic rolled oats",
      },
      brandedFoodInfo: null,
      legacyFoodInfo: null,
      nutritionInfo: { nutrientsPer100: { "208": 380 } },
      portionInfoRaw: [],
      linkedProducts: [],
    };
    const result = await callMcpTool(
      createMcpServer(),
      "usda_food",
      { action: "search", query: "synthetic oats" },
      {
        usdaService: fromPartial({
          listFoods: async () => ({ data: [row], count: 1 }),
        }),
      },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          fdc_id: 9900001,
          description: "Synthetic rolled oats",
          nutrientsPer100: { "208": 380 },
        },
      ],
    });
  });

  it.each([
    ["activity", "problems"],
    ["usda_food", "search"],
  ])(
    "rejects invalid pagination before executing %s.%s",
    async (tool, action) => {
      for (const input of [
        { pageIndex: -1 },
        { pageSize: 0 },
        { pageSize: 101 },
      ]) {
        const result = await callMcpTool(
          createMcpServer(),
          tool,
          {
            action,
            query: "synthetic food",
            type: "orphanedProducts",
            ...input,
          },
          {},
        );
        expect(result.isError).toBe(true);
      }
    },
  );
});
